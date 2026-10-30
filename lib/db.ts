// Data access. In-memory mock mirroring supabase/migrations/0001_init.sql.
// ponytail: mock only; swap bodies for Supabase PostgREST calls once SUPABASE_URL is set,
// keeping these signatures. State lives in one process (fine on a Render web service).

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

type Store = {
  shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[];
  order_items: OrderItem[]; events: Event[]; ledger: LedgerRow[]; decisions: Decision[]; seq: number;
};

function seed(): Store {
  return {
    shops: [
      { id: 'bakery', name: 'Crumb Bakery', fee_bps: 1000, payout_email: process.env.PAYOUT_EMAIL_BAKERY || null },
      { id: 'cafe', name: 'Level G Café', fee_bps: 1000, payout_email: process.env.PAYOUT_EMAIL_CAFE || null },
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

export function resetDb() { g.__liftdrop = seed(); }

export async function listShops() { return db().shops; }
export async function listItems() { return db().items; }

export async function insertOrder(o: Omit<Order, 'created_at' | 'captured_cents' | 'paypal_order_id' | 'authorization_id' | 'capture_id' | 'payout_batch_id' | 'customer_message' | 'status'>, comps: Compartment[], items: OrderItem[]) {
  const order: Order = {
    ...o, status: 'created', captured_cents: 0, paypal_order_id: null, authorization_id: null,
    capture_id: null, payout_batch_id: null, customer_message: null, created_at: now(),
  };
  db().orders.push(order);
  db().compartments.push(...comps);
  db().order_items.push(...items);
  return order;
}

export async function newOrderId() { return `o_${nextId()}`; }

export async function getOrder(id: string) {
  const o = db().orders.find((x) => x.id === id);
  if (!o) throw new Error(`order ${id} not found`);
  return o;
}

export async function updateOrder(id: string, patch: Partial<Order>) {
  return Object.assign(await getOrder(id), patch);
}

export async function listOrders() { return [...db().orders].reverse(); }

export async function getCompartments(orderId: string) {
  return db().compartments.filter((c) => c.order_id === orderId);
}

export async function updateCompartment(orderId: string, id: string, patch: Partial<Compartment>) {
  const c = db().compartments.find((x) => x.order_id === orderId && x.id === id);
  if (!c) throw new Error(`compartment ${orderId}/${id} not found`);
  return Object.assign(c, patch);
}

export async function getOrderItems(orderId: string) {
  return db().order_items.filter((x) => x.order_id === orderId);
}

export async function insertEvent(orderId: string, type: string, payload: Record<string, unknown>) {
  const e: Event = { id: nextId(), order_id: orderId, type, payload, at: now() };
  db().events.push(e);
  return e;
}

export async function insertLedger(rows: Omit<LedgerRow, 'id' | 'at'>[]) {
  db().ledger.push(...rows.map((r) => ({ ...r, id: nextId(), at: now() })));
}

export async function listLedger(orderId?: string) {
  return db().ledger.filter((r) => !orderId || r.order_id === orderId);
}

export async function insertDecision(d: Omit<Decision, 'id' | 'at'>) {
  const row: Decision = { ...d, id: nextId(), at: now() };
  db().decisions.push(row);
  return row;
}

export async function listDecisions(orderId?: string) {
  return db().decisions.filter((d) => !orderId || d.order_id === orderId);
}

export async function snapshot() {
  const s = db();
  return {
    shops: s.shops, items: s.items, orders: [...s.orders].reverse(), compartments: s.compartments,
    order_items: s.order_items, ledger: s.ledger, decisions: s.decisions, events: s.events.slice(-50),
  };
}
