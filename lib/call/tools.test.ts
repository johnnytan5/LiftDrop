// Call tools: the rules Muse Spark can't talk its way around. node --test lib/call/tools.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool, type Cart, type CallCtx } from './tools.ts';

const shops = ['bakery', 'cafe', 'noodles'].map((id) => ({ id, name: id, fee_bps: 1000, payout_email: null }));
const items = [
  { id: 'croissant', shop_id: 'bakery', name: 'Butter croissant', price_cents: 450, grams: 80, stock: 9 },
  { id: 'iced-latte', shop_id: 'cafe', name: 'Iced latte', price_cents: 900, grams: 450, stock: 9 },
  { id: 'dumplings', shop_id: 'noodles', name: 'Pork dumplings (6)', price_cents: 950, grams: 250, stock: 9 },
];
function ctx() {
  let cart: Cart = {};
  let checkedOut = false;
  const c: CallCtx = { items, shops, getCart: () => cart, setCart: (x) => { cart = x; }, checkout: () => { checkedOut = true; }, status: () => null };
  return { c, cart: () => cart, checkedOut: () => checkedOut };
}

test('update_basket sets, clamps and removes; totals come from the menu', () => {
  const t = ctx();
  const r = runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 2 }, { item_id: 'iced-latte', qty: 99 }] }, t.c) as { basket: { total: string } };
  assert.deepEqual(t.cart(), { croissant: 2, 'iced-latte': 5 });
  assert.equal(r.basket.total, '$54.00');
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 0 }] }, t.c);
  assert.deepEqual(t.cart(), { 'iced-latte': 5 });
});

test('unknown items and a third shop are refused without touching the basket', () => {
  const t = ctx();
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }] }, t.c);
  const third = runTool('update_basket', { changes: [{ item_id: 'dumplings', qty: 1 }] }, t.c) as { error: string };
  assert.match(third.error, /two shops/);
  assert.match((runTool('update_basket', { changes: [{ item_id: 'caviar', qty: 1 }] }, t.c) as { error: string }).error, /not on the menu/);
  assert.deepEqual(t.cart(), { croissant: 1, 'iced-latte': 1 });
  // Swapping a shop out in one call is fine.
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 0 }, { item_id: 'dumplings', qty: 1 }] }, t.c);
  assert.deepEqual(t.cart(), { 'iced-latte': 1, dumplings: 1 });
});

test('checkout needs a basket; it only shows the PayPal button, never pays', () => {
  const t = ctx();
  assert.match((runTool('checkout', {}, t.c) as { error: string }).error, /empty/);
  assert.equal(t.checkedOut(), false);
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 1 }] }, t.c);
  assert.ok('next' in runTool('checkout', {}, t.c));
  assert.equal(t.checkedOut(), true);
  assert.match((runTool('order_status', {}, t.c) as { error: string }).error, /No order/);
});

test('caller says they are done: the line checks out even if Spark only asks "anything else?"', async () => {
  const { CallSession } = await import('./session.ts');
  const t = ctx();
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 1 }] }, t.c);
  const said: string[] = [];
  const s = new CallSession(t.c, { onSay: async (x) => { said.push(x); }, onEnd: () => {}, onLog: () => {} });
  s.complete = async () => ({ message: { role: 'assistant', content: 'Anything else for you?' }, ms: 1 });
  await s.onCaller('That is everything, I would like to pay now.');
  assert.equal(t.checkedOut(), true);
  assert.match(said.at(-1)!, /Approve in PayPal/);
  // An ordinary turn doesn't.
  const u = ctx();
  runTool('update_basket', { changes: [{ item_id: 'croissant', qty: 1 }] }, u.c);
  const s2 = new CallSession(u.c, { onSay: async () => {}, onEnd: () => {}, onLog: () => {} });
  s2.complete = async () => ({ message: { role: 'assistant', content: 'Sure.' }, ms: 1 });
  await s2.onCaller('Can I also get a latte?');
  assert.equal(u.checkedOut(), false);
});
