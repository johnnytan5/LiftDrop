// Compartment cameras (SAM 3.1 results) as evidence, and unclaimed orders released.
// Mocks only: node --test lib/camera.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.ts';
import * as paypal from './paypal.ts';
import { createOrder, authorize, handleEvent as handleOne, unlock, payoutSent, syncPayout, type SensorEvent } from './orders.ts';
// The customer types the right code as soon as the robot arrives (the lock has its own test).
const handleEvent = async (id: string, ev: SensorEvent) => {
  const r = await handleOne(id, ev);
  if (ev.type === 'arrived') await unlock(id, (await db.getSecret(id))!.code);
  return r;
};

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

async function deliver(...evs: (SensorEvent | ((id: string) => Promise<unknown>))[]) {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }]);
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
  const { order, decisions } = await deliver(
    ...open('A', 0), camera('A', { 'croissant#1': true }), close('A'),
    { type: 'timeout' },  // round 1: the agent asks the customer to check
    { type: 'timeout' }); // round 2: still unclear -> nothing charged
  assert.deepEqual(decisions.map((d) => (d.applied as { action: string }).action), ['wait', 'void']);
  assert.equal(order.status, 'voided');
  assert.equal(order.captured_cents, 0);
});

test('scale and camera agree: charge the croissant, release the latte', async () => {
  const { order, sum } = await deliver(
    ...open('A', 0), ...open('B', 450), camera('A', { 'croissant#1': false }), camera('B', { 'iced-latte#1': true }), close('A'), close('B'));
  assert.equal(order.status, 'paid_out');
  assert.equal(order.captured_cents, 450);
  assert.equal(sum('voided'), 900);
  assert.equal(sum('paid_out', 'bakery'), 427);
});

test('a paid order no robot picks up is cancelled after 15 minutes: hold released', async () => {
  const { expireUnclaimed, UNCLAIMED_MS } = await import('./orders.ts');
  const hold = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }]);
  const claimed = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }]);
  for (const o of [hold, claimed]) await authorize(o.id);
  await db.updateOrder(claimed.id, { robot_session: 'tab-1' });
  await expireUnclaimed(Date.now(), true); // too young: nothing happens
  assert.equal((await db.getOrder(hold.id)).status, 'held');
  await expireUnclaimed(Date.now() + UNCLAIMED_MS + 1000, true);
  const [h, k] = await Promise.all([hold, claimed].map((o) => db.getOrder(o.id)));
  assert.equal(h.status, 'voided');
  assert.match(h.customer_message!, /Nothing was charged/);
  assert.equal(k.status, 'held'); // a robot has it: leave it alone
  const { STUCK_MS } = await import('./orders.ts');
  await expireUnclaimed(Date.now() + STUCK_MS + 1000, true); // its robot never finished
  assert.equal((await db.getOrder(claimed.id)).status, 'voided');
});
