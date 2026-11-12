// Phone-call tools. Muse Spark decides which to call; they run in the browser against the
// customer's basket, so the call and the screen always show the same order. Payment is never
// a tool: only the customer can approve in PayPal's own window.
import type { Item, Shop } from '../db.ts';
import type { ToolDef } from '../llm.ts';

export type Cart = Record<string, number>;
export type OfficeFloor = 20 | 23;
export const OFFICES: Record<OfficeFloor, string> = { 20: 'Orbit Labs', 23: 'Halden Capital' };
export type Caller = { name: string; floor: OfficeFloor };
export type CallCtx = {
  items: Item[];
  shops: Shop[];
  getCart(): Cart;
  setCart(c: Cart): void;
  checkout(): void;           // show the PayPal approve card
  status(): object | null;    // the live order, if there is one
  caller(): Caller;           // the signed-in account and the floor on screen
  setFloor(f: OfficeFloor): void;
};

const MAX_QTY = 5;
const MAX_SHOPS = 2; // two compartments, one shop each
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

export function basketView(items: Item[], shops: Shop[], cart: Cart) {
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => {
    const it = items.find((i) => i.id === id)!;
    return { item_id: id, name: it.name, shop: shops.find((s) => s.id === it.shop_id)?.name ?? it.shop_id, qty, price: $(it.price_cents * qty) };
  });
  const total = Object.entries(cart).reduce((s, [id, q]) => s + (items.find((i) => i.id === id)?.price_cents ?? 0) * q, 0);
  return { lines, total: $(total), shops: [...new Set(lines.map((l) => l.shop))] };
}

/** Set quantities (0 removes). Rejects unknown items and a third shop without changing anything. */
export function updateBasket(items: Item[], shops: Shop[], cart: Cart, changes: unknown): { cart: Cart } | { error: string } {
  if (!Array.isArray(changes) || !changes.length) return { error: 'changes must list at least one {item_id, qty}' };
  const next = { ...cart };
  for (const c of changes as { item_id?: unknown; qty?: unknown }[]) {
    const id = String(c?.item_id ?? '');
    if (!items.some((i) => i.id === id)) return { error: `"${id}" is not on the menu. Use an item_id from the menu.` };
    const qty = Math.max(0, Math.min(MAX_QTY, Math.round(Number(c.qty) || 0)));
    if (qty) next[id] = qty; else delete next[id];
  }
  const inBasket = new Set(Object.keys(next).map((id) => items.find((i) => i.id === id)!.shop_id));
  if (inBasket.size > MAX_SHOPS) {
    return { error: `The robot carries from ${MAX_SHOPS} shops per trip and this would need ${inBasket.size}: ${[...inBasket].map((s) => shops.find((x) => x.id === s)?.name ?? s).join(', ')}. Ask which two shops they want.` };
  }
  return { cart: next };
}

export function runTool(name: string, args: unknown, ctx: CallCtx): object {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'update_basket': {
      const r = updateBasket(ctx.items, ctx.shops, ctx.getCart(), a.changes);
      if ('error' in r) return r;
      ctx.setCart(r.cart);
      return { basket: basketView(ctx.items, ctx.shops, r.cart) };
    }
    case 'checkout': {
      const cart = ctx.getCart();
      if (!Object.keys(cart).length) return { error: 'The basket is empty. Ask what they would like first.' };
      ctx.checkout();
      return { basket: basketView(ctx.items, ctx.shops, cart), next: 'An "Approve in PayPal" button is now on their screen. PayPal holds the total; they are charged only for what they take out of the robot.' };
    }
    case 'set_floor': {
      const f = Number(a.floor);
      if (f !== 20 && f !== 23) return { error: 'LiftDrop delivers to Level 20 (Orbit Labs) or Level 23 (Halden Capital) only. Ask which.' };
      ctx.setFloor(f);
      return { floor: f, office: OFFICES[f] };
    }
    case 'order_status':
      return ctx.status() ?? { error: 'No order has been paid yet.' };
    case 'end_call':
      return { ended: true };
    default:
      return { error: `unknown tool ${name}` };
  }
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOL_DEFS: ToolDef[] = [
  fn('update_basket', 'Set the quantity of one or more menu items in the basket. qty 0 removes an item.', {
    changes: {
      type: 'array',
      items: { type: 'object', properties: { item_id: { type: 'string', description: 'id from the menu' }, qty: { type: 'integer', minimum: 0, maximum: MAX_QTY } }, required: ['item_id', 'qty'] },
    },
  }, ['changes']),
  fn('checkout', 'The customer has everything they want: put the PayPal approve button on their screen.'),
  fn('set_floor', 'Change the delivery floor when the caller says it is not the one on file.', {
    floor: { type: 'integer', enum: [20, 23] },
  }, ['floor']),
  fn('order_status', 'Where the paid order and the robot are now.'),
  fn('end_call', 'Hang up once the customer says goodbye or needs nothing else.'),
];
