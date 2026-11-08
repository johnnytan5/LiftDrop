// Compartment cameras (SAM 3.1 results) as evidence, and the "pay now, refund what's left" mode.
// Mocks only: node --test lib/camera-and-refunds.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.ts';
import * as paypal from './paypal.ts';
import { createOrder, authorize, handleEvent, payoutSent, syncPayout, type SensorEvent } from './orders.ts';
import { combine } from './handoff.ts';
import { seen, type CameraCheck } from './vision.ts';

delete process.env.LLM_API_KEY; // deterministic fallback
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.PAYPAL_MODE;
beforeEach(() => { db.resetDb(); paypal.resetMock(); });

const box = { x1: 1, y1: 1, x2: 9, y2: 9, w: 10, h: 10, c: 0.9 };
const photo = (found: Record<string, boolean>, failed: string[] = []): CameraCheck =>
  ({ found: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v ? box : null])), failed, ms: 1, at: '' });

test('camera verdicts: a failed call is never "gone"', () => {
  assert.equal(seen(photo({ 'croissant#1': false })), 'gone');
  assert.equal(seen(photo({ 'croissant#1': true })), 'present');
  assert.equal(seen(photo({ 'croissant#1': false, 'croissant#2': true })), 'partial');
  assert.equal(seen(photo({ 'croissant#1': false }, ['croissant#2'])), 'unknown');
  assert.equal(seen(null), 'unknown');
});

test('weight and camera must agree before anything is charged', () => {
  assert.equal(combine(true, 'gone'), true);
  assert.equal(combine(true, 'unknown'), true);          // no camera: the scale decides, as before
  assert.equal(combine(true, 'present'), 'ambiguous');   // scale says taken, camera still sees it
  assert.equal(combine(true, 'partial'), 'ambiguous');
  assert.equal(combine(false, 'present'), false);
  assert.equal(combine(false, 'gone'), 'ambiguous');     // camera says gone, scale didn't move
  assert.equal(combine('ambiguous', 'gone'), 'ambiguous');
});

async function deliver(mode: 'hold' | 'charge', ...evs: (SensorEvent | ((id: string) => Promise<unknown>))[]) {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }], mode);
  const held = await authorize(o.id);
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'loaded', compartment: 'B' }, { type: 'arrived', floor: 23 }, ...evs] as (SensorEvent | ((id: string) => Promise<unknown>))[]) {
    if (typeof ev === 'function') await ev(o.id); else await handleEvent(o.id, ev);
  }
  await payoutSent(o.id);
  await syncPayout(o.id);
  const ledger = await db.listLedger(o.id);
  const sum = (kind: string, shop?: string) => ledger.filter((r) => r.kind === kind && (shop === undefined || r.shop_id === shop)).reduce((s, r) => s + r.amount_cents, 0);
  return { held, order: await db.getOrder(o.id), sum, decisions: await db.listDecisions(o.id) };
}
const camera = (c: string, found: Record<string, boolean>) => (id: string) => db.updateCompartment(id, c, { vision_after: photo(found) });
const open = (c: string, grams: number): SensorEvent[] => [{ type: 'door_opened', compartment: c }, { type: 'weight', compartment: c, grams }];
const close = (c: string): SensorEvent => ({ type: 'door_closed', compartment: c });

test('camera still sees the croissant although the scale dropped: ask, never charge it', async () => {
  const { order, decisions } = await deliver('hold',
    ...open('A', 0), camera('A', { 'croissant#1': true }), close('A'),
    { type: 'timeout' },  // round 1: the agent asks the customer to check
    { type: 'timeout' }); // round 2: still unclear -> nothing charged
  assert.deepEqual(decisions.map((d) => (d.applied as { action: string }).action), ['wait', 'void']);
  assert.equal(order.status, 'voided');
  assert.equal(order.captured_cents, 0);
});

test('scale and camera agree: charge the croissant, release the latte', async () => {
  const { order, sum } = await deliver('hold',
    ...open('A', 0), ...open('B', 450), camera('A', { 'croissant#1': false }), camera('B', { 'iced-latte#1': true }), close('A'), close('B'));
  assert.equal(order.status, 'paid_out');
  assert.equal(order.captured_cents, 450);
  assert.equal(sum('voided'), 900);
  assert.equal(sum('paid_out', 'bakery'), 405);
});

test('pay now: full charge at order, latte left -> refund $9.00, bakery paid', async () => {
  const { held, order, sum } = await deliver('charge',
    ...open('A', 0), ...open('B', 450), camera('A', { 'croissant#1': false }), camera('B', { 'iced-latte#1': true }), close('A'), close('B'));
  assert.equal(held.status, 'held');
  assert.equal(held.captured_cents, 1350); // charged up front
  assert.equal(sum('held'), 0);
  assert.equal(sum('captured'), 1350);
  assert.equal(sum('refunded'), 900);
  assert.equal(order.captured_cents, 450);   // net
  assert.equal(order.status, 'paid_out');
  assert.equal(sum('paid_out', 'bakery'), 405);
  assert.equal(sum('paid_out', 'cafe'), 0);
  assert.match(order.customer_message!, /refunded \$9\.00/);
});

test('pay now: nothing taken -> refunded in full, no payout', async () => {
  const { order, sum } = await deliver('charge', { type: 'timeout' });
  assert.equal(order.status, 'voided');
  assert.equal(sum('refunded'), 1350);
  assert.equal(sum('paid_out'), 0);
  assert.match(order.customer_message!, /Refunded \$13\.50/);
});

test('pay now: everything taken -> no refund', async () => {
  const { order, sum } = await deliver('charge', ...open('A', 0), ...open('B', 0), close('A'), close('B'));
  assert.equal(sum('refunded'), 0);
  assert.equal(order.captured_cents, 1350);
  assert.equal(order.status, 'paid_out');
});

test('mock PayPal refuses refunds beyond the capture', async () => {
  const o = await paypal.createOrder(1000, 'r-create');
  const { authorizationId } = await paypal.authorizeOrder(o.id, 'r-auth');
  const cap = await paypal.captureAuthorization(authorizationId, 1000, 'r-cap');
  await paypal.refundCapture(cap.id, 600, 'r-ref1');
  await assert.rejects(paypal.refundCapture(cap.id, 500, 'r-ref2'), /exceeds/);
  assert.deepEqual(await paypal.refundCapture(cap.id, 600, 'r-ref1'), await paypal.refundCapture(cap.id, 600, 'r-ref1')); // idempotent
});
