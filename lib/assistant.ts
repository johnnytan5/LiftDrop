// Order assistant: "a croissant and something cold" -> a cart from the real menu.
// The model only picks item ids and quantities; prices and totals always come from the DB.

import * as db from './db.ts';
import { callTool, llmConfigured, type ToolDef } from './llm.ts';
import type { CartLine } from './orders.ts';

const TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'set_cart',
    description: 'Set the customer cart from the menu.',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' }, qty: { type: 'integer' } }, required: ['item_id', 'qty'] } },
        reply: { type: 'string', description: 'One short friendly sentence about the cart, or a question if nothing fits' },
      },
      required: ['lines', 'reply'],
    },
  },
};

const SYSTEM = `You take food orders for LiftDrop, a robot that brings orders from the shops in the lobby up to the
customer's floor. Pick items ONLY from the menu JSON by id, qty 1-5. If nothing on the menu fits, return no lines and
say what is available. The robot carries from at most TWO shops per order: if the customer wants more,
pick the two best-matching shops and say the rest needs a second order. Never mention prices. Always answer by calling set_cart exactly once.`;

export type Suggestion = { lines: CartLine[]; reply: string; source: 'llm' | 'keywords' };

export async function suggestCart(message: string): Promise<Suggestion> {
  const items = await db.listItems();
  const shopOf = (id: string) => items.find((i) => i.id === id)?.shop_id;
  const clean = (lines: CartLine[]) => {
    const real = lines.filter((l) => shopOf(l.item_id));
    const shops = [...new Set(real.map((l) => shopOf(l.item_id)))].slice(0, 2); // two compartments, one shop each
    return real.filter((l) => shops.includes(shopOf(l.item_id)))
      .map((l) => ({ item_id: l.item_id, qty: Math.min(5, Math.max(1, Math.round(Number(l.qty) || 1))) }));
  };

  if (llmConfigured()) {
    try {
      const menu = items.map(({ id, name, shop_id }) => ({ id, name, shop_id }));
      const r = await callTool<{ lines: CartLine[]; reply: string }>(SYSTEM, JSON.stringify({ menu, message }), TOOL);
      return { lines: clean(r.lines ?? []), reply: String(r.reply ?? '').slice(0, 200), source: 'llm' };
    } catch (e) {
      console.error('assistant llm failed, using keywords:', e);
    }
  }
  // ponytail: word match on item names; the LLM handles anything fuzzier.
  const text = message.toLowerCase();
  const lines = clean(items.filter((i) => i.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && text.includes(w))).map((i) => ({ item_id: i.id, qty: 1 })));
  return { lines, reply: lines.length ? 'Added to your bag.' : `Try the ${items.map((i) => i.name.toLowerCase()).join(', ')}.`, source: 'keywords' };
}
