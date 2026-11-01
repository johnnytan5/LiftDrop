// Order state machine and money flow. The only place order status changes.

import * as db from './db.ts';
import type { Compartment, Order, OrderStatus } from './db.ts';
import * as paypal from './paypal.ts';
import { decide, toFacts, type Applied } from './handoff.ts';

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
  failed: [],
};

async function move(order: Order, to: OrderStatus, patch: Partial<Order> = {}) {
  if (!NEXT[order.status].includes(to)) throw new Error(`order ${order.id}: ${order.status} -> ${to} not allowed`);
  return db.updateOrder(order.id, { ...patch, status: to }, order.status);
}

const COMPARTMENT_IDS = ['A', 'B'];
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
      order_id: id, id: COMPARTMENT_IDS[i], shop_id, loaded: false, door_opened: false, start_g: null, end_g: null,
      value_cents: mine.reduce((s, l) => s + l.item.price_cents * l.qty, 0),
      expected_g: mine.reduce((s, l) => s + l.item.grams * l.qty, 0),
    };
  });
  const total = comps.reduce((s, c) => s + c.value_cents, 0);
  const orderItems = lines.map((l) => ({
    order_id: id, item_id: l.item.id, qty: l.qty,
    compartment_id: comps.find((c) => c.shop_id === l.item.shop_id)!.id,
  }));
  await db.insertOrder({ id, location, total_cents: total }, comps, orderItems);
  const pp = await paypal.createOrder(total, `liftdrop-${id}-create`);
  return db.updateOrder(id, { paypal_order_id: pp.id });
}

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
    case 'arrived':
      return move(order, 'at_door', { customer_message: 'Arrived. Open the compartment and take your order.' });
    case 'door_opened':
      atDoor(order);
      await db.updateCompartment(orderId, has(ev.compartment), { door_opened: true });
      return order;
    case 'weight':
      atDoor(order);
      await db.updateCompartment(orderId, has(ev.compartment), { end_g: ev.grams });
      return order;
    case 'door_closed':
      atDoor(order);
      return comps.every((c) => c.door_opened) ? handoff(order, comps) : order;
    case 'timeout':
      atDoor(order);
      return handoff(order, comps);
    default:
      throw new Error(`unknown event ${(ev as { type: string }).type}`);
  }
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
    startPayout(captured, d.charge_compartments);
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

// ponytail: background work lives in this process (single Render instance), like the payout poller.
const payoutJobs = new Map<string, Promise<void>>();
/** Resolves once the payout batch for this order has been sent (or failed). For tests and scripts. */
export const payoutSent = (orderId: string) => payoutJobs.get(orderId) ?? Promise.resolve();

function startPayout(order: Order, charged: string[]) {
  const job = payShops(order, charged)
    .then((o) => watchPayout(o.id))
    .catch((e) => { console.error(`payout ${order.id}:`, e); return fail(order.id, e); })
    .finally(() => payoutJobs.delete(order.id));
  payoutJobs.set(order.id, job);
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

async function payShops(order: Order, charged: string[]) {
  const [allComps, shops] = await Promise.all([db.getCompartments(order.id), db.listShops()]);
  const split = splitPayouts(allComps.filter((c) => charged.includes(c.id)), shops);
  const sandbox = process.env.PAYPAL_MODE === 'sandbox';
  const items = split.map((s) => {
    if (!s.shop.payout_email && sandbox) throw new Error(`shop ${s.shop.id} has no payout email`);
    return { shop_id: s.shop.id, email: s.shop.payout_email ?? `${s.shop.id}@example.com`, cents: s.net };
  });
  const batch = await paypal.createPayout(`liftdrop-${order.id}-payout`, items);
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
  const pending = (await db.listLedger(orderId)).filter((r) => r.kind === 'payout_pending');
  if (!p.ok) {
    await db.insertEvent(orderId, 'error', { message: `payout ${p.status}`, items: p.items });
    return move(order, 'failed');
  }
  await db.insertLedger(pending.map((r) => ({ order_id: orderId, shop_id: r.shop_id, kind: 'paid_out' as const, amount_cents: r.amount_cents, paypal_ref: r.paypal_ref })));
  return move(order, 'paid_out');
}

// ponytail: in-process poller (single Render instance). Orders left in paying_out by a restart
// are picked up by syncPendingPayouts() on the next /api/state read.
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

export async function syncPendingPayouts() {
  for (const o of await db.listOrdersByStatus('paying_out')) watchPayout(o.id);
}
