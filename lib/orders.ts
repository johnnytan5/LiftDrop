// Order state machine and money flow. The only place order status changes.

import * as db from './db.ts';
import type { Order, OrderStatus } from './db.ts';
import * as paypal from './paypal.ts';
import { decide, toFacts, type Applied } from './handoff.ts';

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  created: ['held', 'failed'],
  held: ['collecting', 'voided', 'failed'],
  collecting: ['en_route', 'voided', 'failed'],
  en_route: ['at_door', 'voided', 'failed'],
  at_door: ['captured', 'partially_captured', 'voided', 'failed'],
  captured: ['paid_out', 'failed'],
  partially_captured: ['paid_out', 'failed'],
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

// ponytail: in-process guard against two events settling the same order at once;
// becomes a conditional UPDATE ... WHERE status='at_door' with Supabase.
const settling = new Set<string>();

export async function handleEvent(orderId: string, ev: SensorEvent) {
  const order = await db.getOrder(orderId);
  await db.insertEvent(orderId, ev.type, ev as unknown as Record<string, unknown>);
  const comps = await db.getCompartments(orderId);
  const has = (id: string) => {
    if (!comps.some((c) => c.id === id)) throw new Error(`order ${orderId} has no compartment ${id}`);
    return id;
  };

  switch (ev.type) {
    case 'loaded': {
      const c = comps.find((x) => x.id === has(ev.compartment))!;
      await db.updateCompartment(orderId, c.id, { loaded: true, start_g: ev.grams ?? c.expected_g });
      let o = order.status === 'held' ? await move(order, 'collecting') : order;
      if ((await db.getCompartments(orderId)).every((x) => x.loaded)) o = await move(o, 'en_route', { customer_message: 'On the way up.' });
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
      return comps.every((c) => c.door_opened) ? handoff(orderId) : order;
    case 'timeout':
      atDoor(order);
      return handoff(orderId);
    default:
      throw new Error(`unknown event ${(ev as { type: string }).type}`);
  }
}

function atDoor(order: Order) {
  if (order.status !== 'at_door') throw new Error(`order ${order.id} is ${order.status}, not at_door`);
}

export async function handoff(orderId: string) {
  if (settling.has(orderId)) return db.getOrder(orderId);
  settling.add(orderId);
  try {
    const order = await db.getOrder(orderId);
    if (order.status !== 'at_door') return order;
    const [comps, orderItems, items, past] = await Promise.all([
      db.getCompartments(orderId), db.getOrderItems(orderId), db.listItems(), db.listDecisions(orderId),
    ]);
    const facts = toFacts(comps, orderItems, items);
    const waits = past.filter((d) => (d.applied as Applied).action === 'wait').length;
    const { proposed, applied, source } = await decide(facts, waits);
    await db.insertDecision({ order_id: orderId, facts, proposed, applied, source, reason: applied.reason });
    if (applied.action === 'wait') return db.updateOrder(orderId, { customer_message: applied.customer_message });
    return settle(order, applied);
  } finally {
    settling.delete(orderId);
  }
}

async function settle(order: Order, d: Applied) {
  const id = order.id;
  try {
    if (d.action === 'void') {
      await paypal.voidAuthorization(order.authorization_id!, `liftdrop-${id}-void`);
      await db.insertLedger([{ order_id: id, shop_id: null, kind: 'voided', amount_cents: order.total_cents, paypal_ref: order.authorization_id }]);
      return move(order, 'voided', { customer_message: d.customer_message });
    }

    const cap = await paypal.captureAuthorization(order.authorization_id!, d.amount_cents, `liftdrop-${id}-capture`);
    const rest = order.total_cents - d.amount_cents;
    await db.insertLedger([
      { order_id: id, shop_id: null, kind: 'captured', amount_cents: d.amount_cents, paypal_ref: cap.id },
      ...(rest > 0 ? [{ order_id: id, shop_id: null, kind: 'voided' as const, amount_cents: rest, paypal_ref: order.authorization_id }] : []),
    ]);
    const captured = await move(order, rest > 0 ? 'partially_captured' : 'captured', {
      captured_cents: d.amount_cents, capture_id: cap.id, customer_message: d.customer_message,
    });
    return payShops(captured, d.charge_compartments);
  } catch (e) {
    const fresh = await db.getOrder(id);
    await db.insertEvent(id, 'error', { message: String(e) });
    if (NEXT[fresh.status].includes('failed')) await move(fresh, 'failed');
    throw e;
  }
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
  const comps = (await db.getCompartments(order.id)).filter((c) => charged.includes(c.id));
  const split = splitPayouts(comps, await db.listShops());
  const sandbox = process.env.PAYPAL_MODE === 'sandbox';
  const items = split.map((s) => {
    if (!s.shop.payout_email && sandbox) throw new Error(`shop ${s.shop.id} has no payout email`);
    return { shop_id: s.shop.id, email: s.shop.payout_email ?? `${s.shop.id}@example.com`, cents: s.net };
  });
  const batch = await paypal.createPayout(`liftdrop-${order.id}-payout`, items);
  await db.insertLedger(split.flatMap((s) => [
    { order_id: order.id, shop_id: s.shop.id, kind: 'fee' as const, amount_cents: s.fee, paypal_ref: null },
    { order_id: order.id, shop_id: s.shop.id, kind: 'paid_out' as const, amount_cents: s.net, paypal_ref: batch.batchId },
  ]));
  return move(order, 'paid_out', { payout_batch_id: batch.batchId });
}
