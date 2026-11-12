// Order state machine and money flow. The only place order status changes.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { after } from 'next/server.js'; // .js: plain Node (tests) resolves the file, not the package export
import * as db from './db.ts';
import type { Compartment, Order, OrderStatus } from './db.ts';
import * as paypal from './paypal.ts';
import { decide, toFacts, type Applied } from './handoff.ts';
import { CODE_WAIT_S } from './sim/tower.ts';

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  created: ['held', 'failed'],
  held: ['collecting', 'voided', 'failed'],
  collecting: ['en_route', 'voided', 'failed'],
  en_route: ['at_door', 'voided', 'failed'],
  at_door: ['captured', 'partially_captured', 'voided', 'failed'],
  captured: ['paying_out', 'failed'],
  partially_captured: ['paying_out', 'failed'],
  paying_out: ['paid_out', 'failed'],
  voided: ['returning'],
  returning: [],
  paid_out: [],
  failed: ['voided'], // only by an operator, after releasing the money (see opsRelease)
};

async function move(order: Order, to: OrderStatus, patch: Partial<Order> = {}) {
  if (!NEXT[order.status].includes(to)) throw new Error(`order ${order.id}: ${order.status} -> ${to} not allowed`);
  return db.updateOrder(order.id, { ...patch, status: to }, order.status);
}

const COMPARTMENT_IDS = ['A', 'B'];
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
export type CartLine = { item_id: string; qty: number };

export async function createOrder(location: string, cart: CartLine[]) {
  const items = await db.listItems();
  if (!cart.length) throw new Error('empty cart');
  const lines = cart.map((l) => {
    const item = items.find((i) => i.id === l.item_id);
    if (!item) throw new Error(`unknown item ${l.item_id}`);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 10) throw new Error(`bad qty for ${l.item_id}`);
    return { item, qty: l.qty };
  });
  const shops = [...new Set(lines.map((l) => l.item.shop_id))];
  if (shops.length > COMPARTMENT_IDS.length) throw new Error('robot has one compartment per shop; too many shops');

  const id = await db.newOrderId();
  const comps = shops.map((shop_id, i) => {
    const mine = lines.filter((l) => l.item.shop_id === shop_id);
    return {
      order_id: id, id: COMPARTMENT_IDS[i], shop_id, loaded: false, door_opened: false, door_closed: false, start_g: null, end_g: null, vendor_loaded_at: null, vision_before: null, vision_after: null,
      value_cents: mine.reduce((s, l) => s + l.item.price_cents * l.qty, 0),
      expected_g: mine.reduce((s, l) => s + l.item.grams * l.qty, 0),
    };
  });
  const total = comps.reduce((s, c) => s + c.value_cents, 0);
  const orderItems = lines.map((l) => ({
    order_id: id, item_id: l.item.id, qty: l.qty, final_sale: !!l.item.final_sale,
    compartment_id: comps.find((c) => c.shop_id === l.item.shop_id)!.id,
  }));
  await db.insertOrder({ id, location, total_cents: total }, comps, orderItems);
  const code = String(randomInt(10_000)).padStart(4, '0');
  await db.insertSecret(id, code);
  const pp = await paypal.createOrder(total, `liftdrop-${id}-create`, undefined, {
    orderId: id, items: lines.map((l) => ({ name: l.item.name, qty: l.qty, unit_cents: l.item.price_cents, final_sale: !!l.item.final_sale })),
  });
  // The only time the code leaves the server: to the phone that placed the order.
  return { ...(await db.updateOrder(id, { paypal_order_id: pp.id })), code };
}

export const MAX_CODE_TRIES = 5;

/** The customer typed their code on the robot's screen. Right code: the compartments may open. */
export async function unlock(orderId: string, code: string) {
  const order = await db.getOrder(orderId);
  atDoor(order);
  const s = await db.getSecret(orderId);
  if (!s) throw new Error(`order ${orderId} has no unlock code`);
  if (s.unlocked_at) return { unlocked: true, tries_left: MAX_CODE_TRIES - s.tries };
  if (s.tries >= MAX_CODE_TRIES) throw new Error('Too many wrong codes. The robot is locked and will take the order back.');
  const typed = Buffer.from(String(code).replace(/\D/g, '').padEnd(4, 'x').slice(0, 4)); // always 4 ASCII bytes
  if (timingSafeEqual(typed, Buffer.from(s.code))) {
    await db.updateSecret(orderId, { unlocked_at: new Date().toISOString() });
    await db.insertEvent(orderId, 'unlocked', { tries: s.tries + 1 });
    return { unlocked: true, tries_left: MAX_CODE_TRIES - s.tries };
  }
  // ponytail: read-then-write count; two racing wrong guesses can count once. Fine at 5 tries.
  await db.updateSecret(orderId, { tries: s.tries + 1 });
  await db.insertEvent(orderId, 'wrong_code', { tries: s.tries + 1 });
  return { unlocked: false, tries_left: MAX_CODE_TRIES - s.tries - 1 };
}

export async function isUnlocked(orderId: string) { return !!(await db.getSecret(orderId))?.unlocked_at; }

/** Buyer approved in PayPal: reserve the funds. */
export async function authorize(orderId: string) {
  const order = await db.getOrder(orderId);
  if (order.status !== 'created') return order; // idempotent for double clicks
  if (!order.paypal_order_id) throw new Error('order has no PayPal order');
  const { authorizationId } = await paypal.authorizeOrder(order.paypal_order_id, `liftdrop-${orderId}-authorize`);
  await db.insertLedger([{ order_id: orderId, shop_id: null, kind: 'held', amount_cents: order.total_cents, paypal_ref: authorizationId }]);
  return move(order, 'held', { authorization_id: authorizationId, customer_message: 'Held, not charged.' });
}

export type SensorEvent =
  | { type: 'loaded'; compartment: string; grams?: number }
  | { type: 'arrived'; floor?: number }
  | { type: 'door_opened'; compartment: string }
  | { type: 'weight'; compartment: string; grams: number }
  | { type: 'door_closed'; compartment: string }
  | { type: 'timeout' };

// In-process guard against two events settling the same order at once; updateOrder's
// status precondition backs it up across processes.
const settling = new Set<string>();

export async function handleEvent(orderId: string, ev: SensorEvent) {
  // Independent round trips in parallel; the event log write doesn't gate anything.
  const [order, comps] = await Promise.all([
    db.getOrder(orderId), db.getCompartments(orderId),
    db.insertEvent(orderId, ev.type, ev as unknown as Record<string, unknown>),
  ]);
  const has = (id: string) => {
    if (!comps.some((c) => c.id === id)) throw new Error(`order ${orderId} has no compartment ${id}`);
    return id;
  };

  switch (ev.type) {
    case 'loaded': {
      const c = comps.find((x) => x.id === has(ev.compartment))!;
      await db.updateCompartment(orderId, c.id, { loaded: true, start_g: ev.grams ?? c.expected_g });
      let o = order.status === 'held' ? await move(order, 'collecting') : order;
      if (comps.every((x) => x.id === c.id || x.loaded)) o = await move(o, 'en_route', { customer_message: 'On the way up.' });
      return o;
    }
    case 'arrived': {
      const o = await move(order, 'at_door', { customer_message: 'Arrived. Open the compartment and take your order.' });
      watchDoor(orderId);
      return o;
    }
    case 'door_opened':
      atDoor(order);
      // The backend, not the robot's screen, decides: no right code, no open door.
      if (!(await isUnlocked(orderId))) throw new Error('compartments stay locked until the customer enters their code');
      await db.updateCompartment(orderId, has(ev.compartment), { door_opened: true, door_closed: false });
      return order;
    case 'weight':
      atDoor(order);
      await db.updateCompartment(orderId, has(ev.compartment), { end_g: ev.grams });
      return order;
    case 'door_closed': {
      if (order.status !== 'at_door') return order; // a late event after the order settled
      const id = has(ev.compartment);
      await db.updateCompartment(orderId, id, { door_closed: true });
      // Decide once every opened door is shut again: one decision per round at the door.
      const now = comps.map((c) => (c.id === id ? { ...c, door_closed: true } : c));
      return now.every((c) => c.door_opened && c.door_closed) ? handoff(order, now) : order;
    }
    case 'timeout':
      atDoor(order);
      return handoff(order, comps);
    default:
      throw new Error(`unknown event ${(ev as { type: string }).type}`);
  }
}

// ---------- signals from the phone, the shop and the sim tab ----------

/** The sim tab that gets here first drives the order (two open tabs never both deliver it). */
export async function claim(orderId: string, session: string) {
  const o = await db.claimOrder(orderId, session.slice(0, 64));
  if (!o) throw new Error(`order ${orderId} is not waiting for a robot`);
  return o;
}

/** Shop staff tapped "Loaded"; the sim sees the flag and puts the bag in the compartment. */
export async function vendorLoaded(orderId: string, compartment: string) {
  const order = await db.getOrder(orderId);
  if (!['held', 'collecting'].includes(order.status)) throw new Error(`order ${orderId} is ${order.status}, not collecting`);
  if (!(await db.getCompartments(orderId)).some((c) => c.id === compartment)) throw new Error(`no compartment ${compartment}`);
  await db.updateCompartment(orderId, compartment, { vendor_loaded_at: new Date().toISOString() });
  return order;
}

/** Customer tapped "I've got it" on the phone; the sim closes the doors and the handoff runs. */
export async function customerDone(orderId: string) {
  const order = await db.getOrder(orderId);
  atDoor(order);
  // A new timestamp per tap: the robot closes its doors again after the agent asked for a check.
  return db.updateOrder(orderId, { customer_done_at: new Date().toISOString() }, 'at_door');
}

// Backstop for a sim tab closed at the door: settle from what the sensors already reported.
// It must outlast the robot's own wait for the gate code (CODE_WAIT_S) plus a door round,
// or it settles an order the robot is still waiting on.
// ponytail: in-process timer (single backend instance); instrumentation.ts re-arms it on boot.
export const DOOR_BACKSTOP_MS = (CODE_WAIT_S + 180) * 1000;
export function watchDoor(orderId: string, ms = DOOR_BACKSTOP_MS) {
  setTimeout(async () => {
    try {
      if ((await db.getOrder(orderId)).status === 'at_door') await handleEvent(orderId, { type: 'timeout' });
    } catch (e) { console.error(`door backstop ${orderId}:`, e); }
  }, ms).unref();
}

function atDoor(order: Order) {
  if (order.status !== 'at_door') throw new Error(`order ${order.id} is ${order.status}, not at_door`);
}

async function handoff(order: Order, comps: Compartment[]) {
  const orderId = order.id;
  if (settling.has(orderId)) return order;
  settling.add(orderId);
  try {
    const [orderItems, items, past] = await Promise.all([db.getOrderItems(orderId), db.listItems(), db.listDecisions(orderId)]);
    const facts = toFacts(comps, orderItems, items);
    const waits = past.filter((d) => (d.applied as Applied).action === 'wait').length;
    const { proposed, applied, source } = await decide(facts, waits);
    const log = db.insertDecision({ order_id: orderId, facts, proposed, applied, source, reason: applied.reason });
    const next = applied.action === 'wait'
      ? db.updateOrder(orderId, { customer_message: applied.customer_message })
      : settle(order, applied);
    return (await Promise.all([next, log]))[0];
  } finally {
    settling.delete(orderId);
  }
}

/** Charge or release, then reply. Shop payouts run after the reply (PayPal takes ~20 s anyway). */
async function settle(order: Order, d: Applied) {
  const id = order.id;
  try {
    if (d.action === 'void') {
      await paypal.voidAuthorization(order.authorization_id!, `liftdrop-${id}-void`);
      const [, voided] = await Promise.all([
        db.insertLedger([{ order_id: id, shop_id: null, kind: 'voided', amount_cents: order.total_cents, paypal_ref: order.authorization_id }]),
        move(order, 'voided', { customer_message: d.customer_message }),
      ]);
      return voided;
    }

    const cap = await paypal.captureAuthorization(order.authorization_id!, d.amount_cents, `liftdrop-${id}-capture`);
    const rest = order.total_cents - d.amount_cents;
    const [, captured] = await Promise.all([
      db.insertLedger([
        { order_id: id, shop_id: null, kind: 'captured', amount_cents: d.amount_cents, paypal_ref: cap.id },
        ...(rest > 0 ? [{ order_id: id, shop_id: null, kind: 'voided' as const, amount_cents: rest, paypal_ref: order.authorization_id }] : []),
      ]),
      move(order, rest > 0 ? 'partially_captured' : 'captured', {
        captured_cents: d.amount_cents, capture_id: cap.id, customer_message: d.customer_message,
      }),
    ]);
    startPayout(captured, d);
    return captured;
  } catch (e) {
    await fail(id, e);
    throw e;
  }
}

async function fail(id: string, e: unknown) {
  const [fresh] = await Promise.all([db.getOrder(id), db.insertEvent(id, 'error', { message: String(e) })]);
  if (NEXT[fresh.status].includes('failed')) await move(fresh, 'failed');
}

// The payout batch is sent after the reply. On serverless (Vercel) the function would be frozen
// once the response is sent, so the job is handed to Next's after(), which keeps it alive.
const payoutJobs = new Map<string, Promise<void>>();
/** Resolves once the payout batch for this order has been sent (or failed). For tests and scripts. */
export const payoutSent = (orderId: string) => payoutJobs.get(orderId) ?? Promise.resolve();

function startPayout(order: Order, d: Pick<Applied, 'charge_compartments' | 'kept'>) {
  const job = payShops(order, d)
    .then((o) => watchPayout(o.id))
    .catch((e) => { console.error(`payout ${order.id}:`, e); return fail(order.id, e); })
    .finally(() => payoutJobs.delete(order.id));
  payoutJobs.set(order.id, job);
  keepAlive(job);
}

/** Outside a request (tests, scripts, boot) there is no after(); the promise just runs. */
function keepAlive(p: Promise<unknown>) {
  try { after(() => p); } catch { /* not in a request scope */ }
}

export function splitPayouts(comps: { shop_id: string; value_cents: number }[], shops: db.Shop[]) {
  const gross = new Map<string, number>();
  for (const c of comps) gross.set(c.shop_id, (gross.get(c.shop_id) ?? 0) + c.value_cents);
  return [...gross].map(([shop_id, g]) => {
    const shop = shops.find((s) => s.id === shop_id)!;
    const fee = Math.round((g * shop.fee_bps) / 10_000);
    return { shop, gross: g, fee, net: g - fee };
  });
}

/** What a shop reads in its PayPal payout email: the order, what it sold, and the fee. */
export function payoutNote(orderId: string, location: string, sold: { name: string; qty: number; cents: number; left?: boolean }[], s: { gross: number; fee: number; net: number; feeBps: number }) {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const floor = /^L(\d+)/.exec(location)?.[1];
  const lines = sold.map((l) => `${l.qty}× ${l.name} ${usd(l.cents)}${l.left ? ' (final sale, not collected)' : ''}`).join(', ');
  return `LiftDrop order ${orderId}${floor ? `, delivered to Level ${floor}` : ''}. Sold: ${lines}. `
    + `Sales ${usd(s.gross)}, LiftDrop fee ${s.feeBps / 100}% -${usd(s.fee)}, paid to you ${usd(s.net)}.`;
}

async function payShops(order: Order, d: Pick<Applied, 'charge_compartments' | 'kept'>) {
  const [allComps, shops, lines, menu] = await Promise.all([db.getCompartments(order.id), db.listShops(), db.getOrderItems(order.id), db.listItems()]);
  // Taken compartments pay in full; uncollected ones pay only their final-sale items.
  const paid = allComps.map((c) => ({ shop_id: c.shop_id, value_cents: d.charge_compartments.includes(c.id) ? c.value_cents : d.kept?.[c.id] ?? 0 }));
  const split = splitPayouts(paid.filter((c) => c.value_cents > 0), shops);
  const sandbox = process.env.PAYPAL_MODE === 'sandbox';
  const items = split.map((s) => {
    if (!s.shop.payout_email && sandbox) throw new Error(`shop ${s.shop.id} has no payout email`);
    // The same items the shop is paid for, named in its payout email.
    const sold = allComps.filter((c) => c.shop_id === s.shop.id).flatMap((c) => {
      const taken = d.charge_compartments.includes(c.id);
      return lines.filter((l) => l.compartment_id === c.id && (taken || (d.kept?.[c.id] && l.final_sale))).map((l) => {
        const item = menu.find((i) => i.id === l.item_id);
        return { name: item?.name ?? l.item_id, qty: l.qty, cents: (item?.price_cents ?? 0) * l.qty, left: !taken };
      });
    });
    const note = payoutNote(order.id, order.location, sold, { gross: s.gross, fee: s.fee, net: s.net, feeBps: s.shop.fee_bps });
    return { shop_id: s.shop.id, email: s.shop.payout_email ?? `${s.shop.id}@example.com`, cents: s.net, note };
  });
  const batch = await paypal.createPayout(`liftdrop-${order.id}-payout`, items, `LiftDrop payout · order ${order.id}`);
  const [, paying] = await Promise.all([
    db.insertLedger(split.flatMap((s) => [
      { order_id: order.id, shop_id: s.shop.id, kind: 'fee' as const, amount_cents: s.fee, paypal_ref: null },
      { order_id: order.id, shop_id: s.shop.id, kind: 'payout_pending' as const, amount_cents: s.net, paypal_ref: batch.batchId },
    ])),
    move(order, 'paying_out', { payout_batch_id: batch.batchId }),
  ]);
  return paying;
}

/** Ask PayPal once; on a terminal batch, record what landed and finish the order. */
export async function syncPayout(orderId: string) {
  const order = await db.getOrder(orderId);
  if (order.status !== 'paying_out' || !order.payout_batch_id) return order;
  const p = await paypal.getPayout(order.payout_batch_id);
  if (!p.done) return order;
  // Two syncs can see the same finished batch at once (the poller and an /api/state sweep, or two
  // server instances). The status move is a compare-and-set, so it goes first: only the sync that
  // wins it writes the paid_out rows; the other gets "changed concurrently" and writes nothing.
  // ponytail: a crash between the two leaves the order paid_out without its rows; a ledger
  // transaction (RPC) would close that if it ever matters.
  let moved: Order;
  try { moved = await move(order, p.ok ? 'paid_out' : 'failed'); } catch { return db.getOrder(orderId); }
  const pending = (await db.listLedger(orderId)).filter((r) => r.kind === 'payout_pending');
  const paidOut = (rows: typeof pending) => db.insertLedger(rows.map((r) => ({ order_id: orderId, shop_id: r.shop_id, kind: 'paid_out' as const, amount_cents: r.amount_cents, paypal_ref: r.paypal_ref })));
  if (!p.ok) {
    // Record the shops PayPal did pay; name the ones it didn't, so ops can see who to chase.
    const landed = new Set(p.items.filter((i) => i.status === 'SUCCESS').map((i) => i.shop_id));
    await paidOut(pending.filter((r) => r.shop_id && landed.has(r.shop_id)));
    const bad = p.items.filter((i) => i.status !== 'SUCCESS').map((i) => `${i.shop_id} ${i.status}`);
    await db.insertEvent(orderId, 'error', { message: bad.length ? `payout to ${bad.join(', ')} (batch ${p.status})` : `payout batch ${p.status}`, items: p.items });
    return moved;
  }
  await paidOut(pending);
  return moved;
}

// In-process poller: moves a payout along fast on a long-running server. On serverless its timers
// stop with the request; syncPendingPayouts() on each /api/state read covers that.
const watching = new Set<string>();
export function watchPayout(orderId: string, everyMs = 3000, maxTries = 60) {
  if (watching.has(orderId)) return;
  watching.add(orderId);
  let tries = 0;
  const tick = async () => {
    try {
      const o = await syncPayout(orderId);
      if (o.status === 'paying_out' && ++tries < maxTries) return void setTimeout(tick, everyMs).unref();
    } catch (e) {
      console.error(`payout sync ${orderId}:`, e);
      if (++tries < maxTries) return void setTimeout(tick, everyMs).unref();
    }
    watching.delete(orderId);
  };
  setTimeout(tick, everyMs).unref(); // unref: never keeps a script or test process alive
}

// A paid order no robot picked up in time (the robot only takes orders younger than this), or one
// whose robot never finished (its tab closed before the door), would hold the customer's money
// forever. Cancel it: release the hold, or refund a pay-now order. A trip takes ~2 minutes.
export const UNCLAIMED_MS = 15 * 60_000;
export const STUCK_MS = 30 * 60_000;
let lastExpiry = 0;
export async function expireUnclaimed(now = Date.now(), force = false) {
  if (!force && now - lastExpiry < 30_000) return; // runs from /api/state polls; once every 30 s is plenty
  lastExpiry = now;
  const before = (await Promise.all((['held', 'collecting', 'en_route'] as const).map((st) => db.listOrdersByStatus(st)))).flat();
  for (const o of before) {
    const age = now - Date.parse(o.created_at);
    if (age < (o.robot_session ? STUCK_MS : UNCLAIMED_MS) || settling.has(o.id)) continue;
    settling.add(o.id);
    try {
      await cancel(o, 'No robot could take your order, so it was cancelled.');
    } catch (e) {
      await fail(o.id, e); // e.g. a mock authorization lost on restart: stop retrying it
    } finally {
      settling.delete(o.id);
    }
  }
  await sweepDoors(now);
}

/** watchDoor's timer, as a sweep for serverless: settle orders that have waited at the door too long. */
async function sweepDoors(now: number) {
  const waiting = await db.listOrdersByStatus('at_door');
  if (!waiting.length) return;
  const arrived = await db.listEvents(waiting.map((o) => o.id), ['arrived']);
  for (const o of waiting) {
    const at = Math.max(...arrived.filter((e) => e.order_id === o.id).map((e) => Date.parse(e.at)));
    if (!Number.isFinite(at) || now - at < DOOR_BACKSTOP_MS || now - at > 3_600_000) continue; // >1 h: left by an old demo run
    await handleEvent(o.id, { type: 'timeout' }).catch((e) => console.error(`door sweep ${o.id}:`, e));
  }
}

/** Give the customer's money back in full and close the order (not yet delivered). */
async function cancel(o: Order, why: string) {
  await paypal.voidAuthorization(o.authorization_id!, `liftdrop-${o.id}-void`);
  await db.insertLedger([{ order_id: o.id, shop_id: null, kind: 'voided', amount_cents: o.total_cents, paypal_ref: o.authorization_id }]);
  return move(o, 'voided', { customer_message: `${why} Nothing was charged.` });
}

// ---------- operator actions (/ops) ----------
// Same money paths as the robot's handoff, started by a person. Each one is logged as an event,
// and settle decisions as a decision with source 'operator'.

async function asOperator<T>(orderId: string, action: string, note: string, fn: (o: Order) => Promise<T>) {
  if (settling.has(orderId)) throw new Error(`order ${orderId} is settling right now; try again in a moment`);
  settling.add(orderId);
  try {
    const out = await fn(await db.getOrder(orderId));
    await db.insertEvent(orderId, 'ops', { action, note });
    return out;
  } finally {
    settling.delete(orderId);
  }
}

/** The robot is at the gate and the sensors couldn't settle it: charge exactly these compartments. */
export function opsSettle(orderId: string, charge: string[], note = '') {
  return asOperator(orderId, `settle:${charge.join('') || 'none'}`, note, async (o) => {
    atDoor(o);
    const comps = await db.getCompartments(orderId);
    const take = comps.filter((c) => charge.includes(c.id));
    if (take.length !== charge.length) throw new Error(`order ${orderId} has no compartment ${charge.find((id) => !comps.some((c) => c.id === id))}`);
    const amount = take.reduce((s, c) => s + c.value_cents, 0);
    const applied: Applied = take.length
      ? { action: 'charge', charge_compartments: take.map((c) => c.id), amount_cents: amount, clamped: false,
          customer_message: `Charged ${usd(amount)} for compartment ${take.map((c) => c.id).join(' and ')}.${amount < o.total_cents ? ` The rest was not charged.` : ''}`,
          reason: `Operator: charge ${take.map((c) => c.id).join(', ')}${note ? ` (${note})` : ''}` }
      : { action: 'void', charge_compartments: [], amount_cents: 0, clamped: false,
          customer_message: 'Not charged.',
          reason: `Operator: release everything${note ? ` (${note})` : ''}` };
    await db.insertDecision({ order_id: orderId, facts: null, proposed: applied, applied, source: 'operator', reason: applied.reason });
    return settle(o, applied);
  });
}

/** Stuck before the gate (no robot, or the robot never got there): cancel and give the money back. */
export function opsCancel(orderId: string, note = '') {
  return asOperator(orderId, 'cancel', note, async (o) => {
    if (!['held', 'collecting', 'en_route'].includes(o.status)) throw new Error(`order ${orderId} is ${o.status}; only orders not yet at the gate can be cancelled`);
    return cancel(o, 'Our operator cancelled your order.');
  });
}

/** A failed order whose money never moved: release the hold in full. */
export function opsRelease(orderId: string, note = '') {
  return asOperator(orderId, 'release', note, async (o) => {
    if (o.status !== 'failed') throw new Error(`order ${orderId} is ${o.status}, not failed`);
    const kinds = new Set((await db.listLedger(orderId)).map((l) => l.kind));
    if (kinds.has('captured') || kinds.has('voided') || !o.authorization_id) {
      throw new Error(`money on ${orderId} already moved (or was never held); check it in PayPal, then mark it resolved`);
    }
    return cancel(o, 'Something went wrong with your order, so our operator cancelled it.');
  });
}

/** Seen and handled outside the app (or nothing to do): take it off the queue. */
export async function opsResolve(orderId: string, note = '') {
  await db.getOrder(orderId); // 404s on a bad id
  await db.insertEvent(orderId, 'ops', { action: 'resolve', note });
  return { ok: true };
}

/** Polled from /api/state: checks every batch still being paid, at most every 3 s per instance.
 *  This is what moves payouts on serverless, where watchPayout's timers don't survive the reply. */
let lastPayoutSync = 0;
export async function syncPendingPayouts(now = Date.now()) {
  if (now - lastPayoutSync < 3000) return;
  lastPayoutSync = now;
  await Promise.all((await db.listOrdersByStatus('paying_out'))
    .map((o) => syncPayout(o.id).catch((e) => console.error(`payout sync ${o.id}:`, e))));
}
