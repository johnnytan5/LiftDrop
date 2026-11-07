// Money lifecycle on mocks: node --test lib/*.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.ts';
import * as paypal from './paypal.ts';
import { createOrder, authorize, handleEvent, payoutSent, syncPayout, claim, vendorLoaded, customerDone, type SensorEvent } from './orders.ts';
import { suggestCart } from './assistant.ts';
import { clamp, decide, type Fact } from './handoff.ts';

delete process.env.LLM_API_KEY; // deterministic fallback
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.PAYPAL_MODE;

beforeEach(() => { db.resetDb(); paypal.resetMock(); });

async function deliver(...evs: SensorEvent[]) {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }]);
  await authorize(o.id);
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'loaded', compartment: 'B' }, { type: 'arrived', floor: 23 }, ...evs] as SensorEvent[]) {
    await handleEvent(o.id, ev);
  }
  await payoutSent(o.id); // payouts run after the reply
  await syncPayout(o.id); // mock batch is SUCCESS on first check
  const ledger = await db.listLedger(o.id);
  const sum = (kind: string, shop?: string) =>
    ledger.filter((r) => r.kind === kind && (shop === undefined || r.shop_id === shop)).reduce((s, r) => s + r.amount_cents, 0);
  return { order: await db.getOrder(o.id), sum, decisions: await db.listDecisions(o.id) };
}

const take = (c: string): SensorEvent[] => [
  { type: 'door_opened', compartment: c }, { type: 'weight', compartment: c, grams: 0 }, { type: 'door_closed', compartment: c },
];

test('both taken: full capture, both shops paid minus 10%', async () => {
  const { order, sum } = await deliver(...take('A'), ...take('B'));
  assert.equal(order.status, 'paid_out');
  assert.equal(order.captured_cents, 1350);
  assert.equal(sum('held'), 1350);
  assert.equal(sum('voided'), 0);
  assert.equal(sum('paid_out', 'bakery'), 405);
  assert.equal(sum('paid_out', 'cafe'), 810);
  assert.equal(sum('fee'), 135);
});

test('latte left: capture croissant only, release the rest, pay bakery only', async () => {
  const { order, sum } = await deliver(...take('A'), { type: 'timeout' });
  assert.equal(order.status, 'paid_out');
  assert.equal(order.captured_cents, 450);
  assert.equal(sum('voided'), 900);
  assert.equal(sum('paid_out', 'bakery'), 405);
  assert.equal(sum('paid_out', 'cafe'), 0);
  assert.match(order.customer_message!, /not charged/);
});

test('nothing taken: void, no payout', async () => {
  const { order, sum } = await deliver({ type: 'timeout' });
  assert.equal(order.status, 'voided');
  assert.equal(sum('captured'), 0);
  assert.equal(sum('voided'), 1350);
  assert.equal(sum('paid_out'), 0);
});

test('ambiguous weight: wait once, then charge only the confirmed compartment', async () => {
  const { order, decisions } = await deliver(
    ...take('A'),
    { type: 'door_opened', compartment: 'B' }, { type: 'weight', compartment: 'B', grams: 200 }, { type: 'door_closed', compartment: 'B' },
    { type: 'timeout' },
  );
  assert.deepEqual(decisions.map((d) => (d.applied as { action: string }).action), ['wait', 'charge']);
  assert.equal(order.captured_cents, 450);
});

test('guardrail: agent cannot charge unconfirmed compartments or wait forever', () => {
  const f = (compartment: string, removed: Fact['removed'], value_cents: number): Fact => ({
    compartment, removed, value_cents, shop_id: 's', items: [], expected_g: 100, start_g: 100, end_g: 0, door_opened: true,
  });
  const facts = [f('A', true, 450), f('B', 'ambiguous', 900)];
  const greedy = clamp({ action: 'charge', charge_compartments: ['A', 'B', 'Z'], customer_message: '', reason: '' }, facts, 0);
  assert.equal(greedy.amount_cents, 450);
  assert.equal(greedy.clamped, true);
  const none = clamp({ action: 'charge', charge_compartments: ['B'], customer_message: '', reason: '' }, facts, 0);
  assert.equal(none.action, 'void');
  const stall = clamp({ action: 'wait', charge_compartments: [], customer_message: '', reason: '' }, facts, 1);
  assert.notEqual(stall.action, 'wait');
});

test('paypal mock: idempotent by request id, rejects over-capture', async () => {
  const { id } = await paypal.createOrder(1000, 'r1');
  const { authorizationId } = await paypal.authorizeOrder(id, 'r2');
  await assert.rejects(paypal.captureAuthorization(authorizationId, 1001, 'r3'), /exceeds/);
  const a = await paypal.captureAuthorization(authorizationId, 500, 'r4');
  const b = await paypal.captureAuthorization(authorizationId, 500, 'r4');
  assert.deepEqual(a, b);
  await assert.rejects(paypal.captureAuthorization(authorizationId, 100, 'r5'), /closed/);
});

test('state machine rejects out-of-order events; paypal failure marks order failed', async () => {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }]);
  await authorize(o.id);
  await assert.rejects(handleEvent(o.id, { type: 'arrived' }), /held -> at_door/);
  await handleEvent(o.id, { type: 'loaded', compartment: 'A' });
  await handleEvent(o.id, { type: 'arrived' });
  await handleEvent(o.id, { type: 'door_opened', compartment: 'A' });
  await handleEvent(o.id, { type: 'weight', compartment: 'A', grams: 0 });
  paypal.setMockFailure('capture');
  await assert.rejects(handleEvent(o.id, { type: 'door_closed', compartment: 'A' }), /mock capture failure/);
  assert.equal((await db.getOrder(o.id)).status, 'failed');
});

test('clean handoff never waits on the LLM; unclear one does', async () => {
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_BASE_URL = 'http://127.0.0.1:9'; // unreachable: an LLM call would fail -> 'fallback'
  try {
    const f = (compartment: string, removed: Fact['removed']): Fact => ({
      compartment, removed, value_cents: 450, shop_id: 's', items: [], expected_g: 100, start_g: 100, end_g: 0, door_opened: true,
    });
    assert.equal((await decide([f('A', true), f('B', false)], 0)).source, 'code');
    assert.equal((await decide([f('A', true), f('B', 'ambiguous')], 0)).source, 'fallback');
  } finally {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
  }
});

test('payout stays pending until PayPal confirms the batch', async () => {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }]);
  await authorize(o.id);
  let reply;
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'arrived' }, { type: 'door_opened', compartment: 'A' },
    { type: 'weight', compartment: 'A', grams: 0 }, { type: 'door_closed', compartment: 'A' }] as SensorEvent[]) reply = await handleEvent(o.id, ev);
  assert.equal(reply!.status, 'captured'); // the reply comes back before payouts are sent
  await payoutSent(o.id);
  assert.equal((await db.getOrder(o.id)).status, 'paying_out');
  const kinds = () => db.listLedger(o.id).then((l) => l.map((r) => r.kind));
  assert.ok((await kinds()).includes('payout_pending'));
  assert.ok(!(await kinds()).includes('paid_out'));
  assert.equal((await syncPayout(o.id)).status, 'paid_out');
  assert.equal((await db.listLedger(o.id)).find((r) => r.kind === 'paid_out')?.amount_cents, 405);
});

test('signals across devices: one sim tab claims, shop loads, customer taps done', async () => {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }]);
  await assert.rejects(claim(o.id, 'tab1'), /not waiting/); // not paid yet
  await authorize(o.id);
  assert.equal((await claim(o.id, 'tab1')).robot_session, 'tab1');
  await assert.rejects(claim(o.id, 'tab2'), /not waiting/); // second tab loses

  await vendorLoaded(o.id, 'A');
  assert.ok((await db.getCompartments(o.id)).find((c) => c.id === 'A')!.vendor_loaded_at);
  await assert.rejects(vendorLoaded(o.id, 'Z'), /no compartment/);

  await assert.rejects(customerDone(o.id), /not at_door/);
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'loaded', compartment: 'B' }, { type: 'arrived' }, ...take('A'), { type: 'door_opened', compartment: 'B' }, { type: 'weight', compartment: 'B', grams: 450 }] as SensorEvent[]) await handleEvent(o.id, ev);
  assert.ok((await customerDone(o.id)).customer_done_at);
  const first = await handleEvent(o.id, { type: 'door_closed', compartment: 'B' }); // A taken, B untouched
  assert.equal(first.status, 'partially_captured');
  assert.equal(first.captured_cents, 450);
  // A late door_closed after settling is ignored, not an error.
  assert.notEqual((await handleEvent(o.id, { type: 'door_closed', compartment: 'B' })).status, 'at_door');
  assert.equal((await db.listDecisions(o.id)).length, 1);
  await payoutSent(o.id);
});

test('assistant without an LLM matches menu words and never invents items', async () => {
  const r = await suggestCart('one croissant and an iced latte please');
  assert.deepEqual(r.lines.map((l) => l.item_id).sort(), ['croissant', 'iced-latte']);
  assert.equal((await suggestCart('a pizza')).lines.length, 0);
});

test('agent asks once: one decision per round at the door, the second round settles', async () => {
  const o = await createOrder('L23-pantry', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }]);
  await authorize(o.id);
  const round = (aGrams: number) => [
    { type: 'door_opened', compartment: 'A' }, { type: 'door_opened', compartment: 'B' },
    { type: 'weight', compartment: 'A', grams: aGrams }, { type: 'weight', compartment: 'B', grams: 450 },
    { type: 'door_closed', compartment: 'A' }, { type: 'door_closed', compartment: 'B' },
  ] as SensorEvent[];
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'loaded', compartment: 'B' }, { type: 'arrived' }] as SensorEvent[]) await handleEvent(o.id, ev);
  let r;
  for (const ev of round(40)) r = await handleEvent(o.id, ev); // half the croissant's weight: unclear
  assert.equal(r!.status, 'at_door');
  assert.deepEqual((await db.listDecisions(o.id)).map((d) => (d.applied as { action: string }).action), ['wait']);
  for (const ev of round(0)) r = await handleEvent(o.id, ev); // customer took it properly
  assert.equal(r!.status, 'partially_captured');
  assert.equal(r!.captured_cents, 450);
  assert.equal((await db.listDecisions(o.id)).length, 2);
  await payoutSent(o.id);
});
