// Data access. Supabase when SUPABASE_URL is set (server-side, service-role key),
// otherwise an in-memory mock mirroring supabase/migrations/0001_init.sql (tests, offline dev).

import { createClient } from '@supabase/supabase-js';

export type OrderStatus =
  | 'created' | 'held' | 'collecting' | 'en_route' | 'at_door'
  | 'captured' | 'partially_captured' | 'voided' | 'returning' | 'paid_out' | 'failed';

export type Shop = { id: string; name: string; fee_bps: number; payout_email: string | null };
export type Item = { id: string; shop_id: string; name: string; price_cents: number; grams: number; stock: number };
export type Order = {
  id: string; location: string; status: OrderStatus; total_cents: number; captured_cents: number;
  paypal_order_id: string | null; authorization_id: string | null; capture_id: string | null;
  payout_batch_id: string | null; customer_message: string | null; created_at: string;
};
export type Compartment = {
  order_id: string; id: string; shop_id: string; value_cents: number; expected_g: number;
  loaded: boolean; door_opened: boolean; start_g: number | null; end_g: number | null;
};
export type OrderItem = { order_id: string; item_id: string; compartment_id: string; qty: number };
export type Event = { id: number; order_id: string; type: string; payload: Record<string, unknown>; at: string };
export type LedgerKind = 'held' | 'captured' | 'voided' | 'fee' | 'paid_out' | 'refunded';
export type LedgerRow = {
  id: number; order_id: string; shop_id: string | null; kind: LedgerKind;
  amount_cents: number; paypal_ref: string | null; at: string;
};
export type Decision = {
  id: number; order_id: string; facts: unknown; proposed: unknown; applied: unknown;
  source: 'llm' | 'fallback'; reason: string; at: string;
};

const sb = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
      // Never hang a request on a dead socket (seen after laptop sleep); fail fast instead.
      global: { fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }) },
    })
  : null;
export const usingSupabase = () => !!sb;

async function q<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`supabase: ${error.message}`);
  return data as T;
}

// Payout receivers come from env so sandbox emails never need a DB edit.
const withEmail = (s: Shop): Shop => ({ ...s, payout_email: process.env[`PAYOUT_EMAIL_${s.id.toUpperCase()}`] || s.payout_email });

type Store = {
  shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[];
  order_items: OrderItem[]; events: Event[]; ledger: LedgerRow[]; decisions: Decision[]; seq: number;
};

function seed(): Store {
  return {
    shops: [
      { id: 'bakery', name: 'Crumb Bakery', fee_bps: 1000, payout_email: null },
      { id: 'cafe', name: 'Level G Café', fee_bps: 1000, payout_email: null },
    ],
    items: [
      { id: 'croissant', shop_id: 'bakery', name: 'Butter croissant', price_cents: 450, grams: 80, stock: 20 },
      { id: 'pain-choc', shop_id: 'bakery', name: 'Pain au chocolat', price_cents: 500, grams: 90, stock: 15 },
      { id: 'iced-latte', shop_id: 'cafe', name: 'Iced latte', price_cents: 900, grams: 450, stock: 30 },
      { id: 'americano', shop_id: 'cafe', name: 'Hot americano', price_cents: 600, grams: 350, stock: 30 },
    ],
    orders: [], compartments: [], order_items: [], events: [], ledger: [], decisions: [], seq: 0,
  };
}

// globalThis survives Next dev hot reloads.
const g = globalThis as { __liftdrop?: Store };
const db = (): Store => (g.__liftdrop ??= seed());
const now = () => new Date().toISOString();
const nextId = () => ++db().seq;

export function resetDb() {
  if (sb) throw new Error('reset is mock-only');
  g.__liftdrop = seed();
}

export async function listShops() {
  return (sb ? await q<Shop[]>(sb.from('shops').select()) : db().shops).map(withEmail);
}
export async function listItems() { return sb ? q<Item[]>(sb.from('items').select().order('id')) : db().items; }

// Time-based so ids (and the PayPal idempotency keys built from them) never repeat across resets.
export async function newOrderId() { return `o_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`; }

type NewOrder = Pick<Order, 'id' | 'location' | 'total_cents'>;

export async function insertOrder(o: NewOrder, comps: Compartment[], items: OrderItem[]) {
  if (sb) {
    // ponytail: three inserts, not one transaction; an orphan order is harmless in a demo.
    const order = await q<Order>(sb.from('orders').insert(o).select().single());
    await q(sb.from('compartments').insert(comps));
    await q(sb.from('order_items').insert(items));
    return order;
  }
  const order: Order = {
    ...o, status: 'created', captured_cents: 0, paypal_order_id: null, authorization_id: null,
    capture_id: null, payout_batch_id: null, customer_message: null, created_at: now(),
  };
  db().orders.push(order);
  db().compartments.push(...comps);
  db().order_items.push(...items);
  return order;
}

export async function getOrder(id: string) {
  const o = sb ? await q<Order | null>(sb.from('orders').select().eq('id', id).maybeSingle()) : db().orders.find((x) => x.id === id);
  if (!o) throw new Error(`order ${id} not found`);
  return o;
}

/** With `from`, the update only applies if the order is still in that status (no double transitions). */
export async function updateOrder(id: string, patch: Partial<Order>, from?: OrderStatus) {
  if (sb) {
    let u = sb.from('orders').update(patch).eq('id', id);
    if (from) u = u.eq('status', from);
    const rows = await q<Order[]>(u.select());
    if (!rows.length) throw new Error(`order ${id} changed concurrently (expected ${from})`);
    return rows[0];
  }
  const o = await getOrder(id);
  if (from && o.status !== from) throw new Error(`order ${id} changed concurrently (expected ${from})`);
  return Object.assign(o, patch);
}

export async function listOrders() {
  return sb ? q<Order[]>(sb.from('orders').select().order('created_at', { ascending: false }).limit(20)) : [...db().orders].reverse();
}

export async function getCompartments(orderId: string) {
  return sb ? q<Compartment[]>(sb.from('compartments').select().eq('order_id', orderId).order('id'))
    : db().compartments.filter((c) => c.order_id === orderId);
}

export async function updateCompartment(orderId: string, id: string, patch: Partial<Compartment>) {
  if (sb) return q<Compartment>(sb.from('compartments').update(patch).eq('order_id', orderId).eq('id', id).select().single());
  const c = db().compartments.find((x) => x.order_id === orderId && x.id === id);
  if (!c) throw new Error(`compartment ${orderId}/${id} not found`);
  return Object.assign(c, patch);
}

export async function getOrderItems(orderId: string) {
  return sb ? q<OrderItem[]>(sb.from('order_items').select().eq('order_id', orderId))
    : db().order_items.filter((x) => x.order_id === orderId);
}

export async function insertEvent(orderId: string, type: string, payload: Record<string, unknown>) {
  if (sb) return q<Event>(sb.from('events').insert({ order_id: orderId, type, payload }).select().single());
  const e: Event = { id: nextId(), order_id: orderId, type, payload, at: now() };
  db().events.push(e);
  return e;
}

export async function insertLedger(rows: Omit<LedgerRow, 'id' | 'at'>[]) {
  if (sb) { await q(sb.from('ledger').insert(rows)); return; }
  db().ledger.push(...rows.map((r) => ({ ...r, id: nextId(), at: now() })));
}

export async function listLedger(orderId?: string) {
  if (sb) {
    const sel = sb.from('ledger').select().order('id');
    return q<LedgerRow[]>(orderId ? sel.eq('order_id', orderId) : sel);
  }
  return db().ledger.filter((r) => !orderId || r.order_id === orderId);
}

export async function insertDecision(d: Omit<Decision, 'id' | 'at'>) {
  if (sb) return q<Decision>(sb.from('decisions').insert(d).select().single());
  const row: Decision = { ...d, id: nextId(), at: now() };
  db().decisions.push(row);
  return row;
}

export async function listDecisions(orderId?: string) {
  if (sb) {
    const sel = sb.from('decisions').select().order('id');
    return q<Decision[]>(orderId ? sel.eq('order_id', orderId) : sel);
  }
  return db().decisions.filter((d) => !orderId || d.order_id === orderId);
}

/** Everything the consoles need, for the 20 most recent orders. */
export async function snapshot() {
  const [shops, items, orders] = await Promise.all([listShops(), listItems(), listOrders()]);
  const ids = new Set(orders.map((o) => o.id));
  const mine = <T extends { order_id: string }>(rows: T[]) => rows.filter((r) => ids.has(r.order_id));
  if (sb) {
    const list = [...ids];
    const [compartments, order_items, ledger, decisions] = await Promise.all([
      q<Compartment[]>(sb.from('compartments').select().in('order_id', list).order('id')),
      q<OrderItem[]>(sb.from('order_items').select().in('order_id', list)),
      q<LedgerRow[]>(sb.from('ledger').select().in('order_id', list).order('id')),
      q<Decision[]>(sb.from('decisions').select().in('order_id', list).order('id')),
    ]);
    return { shops, items, orders, compartments, order_items, ledger, decisions };
  }
  const s = db();
  return { shops, items, orders, compartments: mine(s.compartments), order_items: mine(s.order_items), ledger: mine(s.ledger), decisions: mine(s.decisions) };
}
