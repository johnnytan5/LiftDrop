// Escalation queue and operator actions, on mocks: node --test lib/ops.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.ts';
import * as paypal from './paypal.ts';
import { authorize, createOrder, handleEvent as handleOne, unlock, opsCancel, opsResolve, opsSettle, payoutSent, type SensorEvent } from './orders.ts';
// The customer types the right code as soon as the robot arrives (the lock has its own test).
const handleEvent = async (id: string, ev: SensorEvent) => {
  const r = await handleOne(id, ev);
  if (ev.type === 'arrived') await unlock(id, (await db.getSecret(id))!.code);
  return r;
};

import { escalations } from './ops.ts';
import type { Robot } from './fleet.ts';

delete process.env.LLM_API_KEY; // deterministic fallback
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.PAYPAL_MODE;

beforeEach(() => { db.resetDb(); paypal.resetMock(); });

async function queue(robots: Robot[] = [], now = Date.now()) {
  const s = await db.snapshot();
  return escalations(s, await db.listEvents(s.orders.map((o) => o.id), ['error', 'ops']), robots, now);
}

test('scale and camera disagree: queued as urgent, operator charges A only', async () => {
  const o = await createOrder('L20-gate', [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }]);
  await authorize(o.id);
  // Half the croissant's weight left in A: ambiguous, so the agent asks the customer and waits.
  for (const ev of [{ type: 'loaded', compartment: 'A' }, { type: 'loaded', compartment: 'B' }, { type: 'arrived', floor: 20 },
    { type: 'door_opened', compartment: 'A' }, { type: 'weight', compartment: 'A', grams: 40 }, { type: 'door_closed', compartment: 'A' },
    { type: 'door_opened', compartment: 'B' }, { type: 'door_closed', compartment: 'B' }] as SensorEvent[]) await handleEvent(o.id, ev);
  assert.equal((await db.getOrder(o.id)).status, 'at_door');

  const [e] = await queue();
  assert.equal(e.kind, 'customer_check');
  assert.equal(e.severity, 'urgent');
  assert.ok(e.detail.some((l) => l.startsWith('A ($4.50): scale 40 g of 80 g')), e.detail.join(' | '));

  const done = await opsSettle(o.id, ['A'], 'customer confirmed on the phone');
  assert.equal(done.status, 'partially_captured');
  assert.equal(done.captured_cents, 450);
  await payoutSent(o.id);
  assert.equal((await db.listDecisions(o.id)).at(-1)!.source, 'operator');
  assert.deepEqual(await queue(), []);
  await assert.rejects(opsSettle(o.id, ['B']), /not at_door/); // can't settle twice
});

test('paid but unclaimed, robot offline: queued, cancel releases the hold', async () => {
  const o = await createOrder('L23-gate', [{ item_id: 'caesar', qty: 1 }]);
  await authorize(o.id);
  assert.deepEqual(await queue(), []); // fresh: give a robot time
  const later = Date.now() + 3 * 60_000;
  const [e] = await queue([], later);
  assert.equal(e.kind, 'unclaimed');
  assert.ok(e.detail.includes('No robot is online.'));

  const v = await opsCancel(o.id);
  assert.equal(v.status, 'voided');
  assert.ok((await db.listLedger(o.id)).some((l) => l.kind === 'voided' && l.amount_cents === 1100));
  assert.deepEqual(await queue([], later), []);
});

test('robot drops offline mid-delivery; resolve takes it off the queue', async () => {
  const o = await createOrder('L23-gate', [{ item_id: 'croissant', qty: 1 }]);
  await authorize(o.id);
  await db.claimOrder(o.id, 'tab-1');
  const robot: Robot = { session: 'tab-1', name: 'LD-01', online: false, phase: 'to Crumb Bakery', floor: 0, x: 0, y: 0, grams: { A: 0, B: 0 }, doors: { A: 0, B: 0 }, order: o.id, speed: 2, first: 0, last: Date.now() - 10_000 };
  const [e] = await queue([robot]);
  assert.equal(e.kind, 'robot_offline');
  assert.deepEqual(e.actions, ['cancel']);
  await opsResolve(o.id, 'robot restarted');
  assert.deepEqual(await queue([robot]), []);
});
