// Handoff: sensor state -> facts -> agent proposal -> code-enforced decision.
// Two independent sensors per compartment: the load cell (weight) and the compartment camera
// (SAM 3.1). The agent may only charge compartments they confirm were emptied; code clamps
// anything else, so a wrong or hostile model can never overcharge.

import type { Compartment, Item, OrderItem } from './db.ts';
import { callTool, llmConfigured, type ToolDef } from './llm.ts';
import { seen, type Seen } from './vision.ts';

export type Removed = true | false | 'ambiguous';
export type Fact = {
  compartment: string; shop_id: string; items: string[]; value_cents: number;
  expected_g: number; start_g: number | null; end_g: number | null; door_opened: boolean;
  weight: Removed;   // the load cell alone
  camera: Seen;      // SAM 3.1 on the photo taken as the doors closed
  removed: Removed;  // both together: what may be charged
  final_cents: number; final_items: string[]; // final-sale items: charged even if not collected
};
export type Proposal = { action: 'charge' | 'wait' | 'void'; charge_compartments: string[]; customer_message: string; reason: string };
export type Applied = Proposal & { amount_cents: number; clamped: boolean; kept?: Record<string, number> };

// ponytail: fixed ±15% band on the item weight; tune per robot once real touch sensors report.
export const WEIGHT_TOLERANCE = 0.15;
export const MAX_WAITS = 1;

/** Weight and camera together. The camera can only confirm or contradict the scale; when it
 *  couldn't check (no photo, a failed call) the scale decides alone, as before cameras. */
export function combine(weight: Removed, camera: Seen): Removed {
  if (camera === 'unknown' || weight === 'ambiguous') return weight;
  if (weight === true) return camera === 'gone' ? true : 'ambiguous';     // scale: taken; camera: still there
  return camera === 'present' ? false : 'ambiguous';                       // scale: untouched; camera: something's gone
}

export function classify(c: Compartment): Removed {
  if (!c.door_opened) return false;
  if (c.end_g === null) return 'ambiguous';
  const dropped = (c.start_g ?? c.expected_g) - c.end_g;
  const ratio = dropped / c.expected_g;
  if (Math.abs(ratio - 1) <= WEIGHT_TOLERANCE) return true;
  if (ratio <= WEIGHT_TOLERANCE) return false;
  return 'ambiguous';
}

export function toFacts(comps: Compartment[], orderItems: OrderItem[], items: Item[]): Fact[] {
  return comps.map((c) => {
    const weight = classify(c);
    // An unopened door can't have been emptied, whatever a photo says.
    const camera: Seen = c.door_opened ? seen(c.vision_after) : 'unknown';
    const mine = orderItems.filter((oi) => oi.compartment_id === c.id);
    const label = (oi: OrderItem) => `${oi.qty}× ${items.find((i) => i.id === oi.item_id)?.name ?? oi.item_id}`;
    const final = mine.filter((oi) => oi.final_sale);
    return {
    compartment: c.id, shop_id: c.shop_id, value_cents: c.value_cents, expected_g: c.expected_g,
    start_g: c.start_g, end_g: c.end_g, door_opened: c.door_opened, weight, camera, removed: combine(weight, camera),
    items: mine.map(label),
    final_items: final.map(label),
    final_cents: final.reduce((s, oi) => s + (items.find((i) => i.id === oi.item_id)?.price_cents ?? 0) * oi.qty, 0),
    };
  });
}

export const cap = (facts: Fact[]) => facts.filter((f) => f.removed === true).reduce((s, f) => s + f.value_cents, 0);

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const names = (fs: Fact[]) => fs.flatMap((f) => f.items).join(', ');

/** The guardrail. Pure; whatever the agent says, the result never exceeds the cap. */
export function clamp(p: Proposal, facts: Fact[], waits: number): Applied {
  if (p.action === 'wait' && waits < MAX_WAITS) return { ...p, charge_compartments: [], amount_cents: 0, clamped: false };
  if (p.action === 'wait') return { ...fallback(facts, waits), clamped: true };
  const confirmed = new Set(facts.filter((f) => f.removed === true).map((f) => f.compartment));
  const asked = p.action === 'charge' ? p.charge_compartments : [];
  const allowed = asked.filter((c) => confirmed.has(c));
  const clamped = allowed.length !== asked.length;
  if (allowed.length === 0) {
    return { action: 'void', charge_compartments: [], amount_cents: 0, clamped: clamped || p.action === 'charge',
      customer_message: p.action === 'void' ? p.customer_message : 'Nothing was collected, so nothing was charged.',
      reason: p.reason };
  }
  const amount = facts.filter((f) => allowed.includes(f.compartment)).reduce((s, f) => s + f.value_cents, 0);
  return { ...p, action: 'charge', charge_compartments: allowed, amount_cents: amount, clamped };
}

/** Deterministic decision used when no LLM is configured or the LLM fails. */
export function fallback(facts: Fact[], waits: number): Applied {
  const taken = facts.filter((f) => f.removed === true);
  const left = facts.filter((f) => f.removed !== true);
  const unsure = facts.filter((f) => f.removed === 'ambiguous');
  if (unsure.length && waits < MAX_WAITS) {
    const ids = unsure.map((f) => f.compartment).join(', ');
    return { action: 'wait', charge_compartments: [], amount_cents: 0, clamped: false,
      customer_message: `Please check compartment ${ids} and close the door.`,
      reason: `Weight and camera in ${ids} don't agree with the items; asking the customer.` };
  }
  if (!taken.length) {
    return { action: 'void', charge_compartments: [], amount_cents: 0, clamped: false,
      customer_message: 'Not delivered, not charged.',
      reason: 'No compartment confirmed empty.' };
  }
  const amount = cap(facts);
  const leftMsg = `${names(left)} not collected, not charged.`;
  return { action: 'charge', charge_compartments: taken.map((f) => f.compartment), amount_cents: amount, clamped: false,
    customer_message: left.length ? `Charged ${money(amount)} for ${names(taken)}. ${leftMsg}` : `Charged ${money(amount)}. Enjoy!`,
    reason: left.length ? `Confirmed removed: ${taken.map((f) => f.compartment).join(', ')}; others not confirmed.` : 'All compartments confirmed empty.' };
}

const TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'decide_handoff',
    description: 'Decide what to charge after a robot delivery handoff.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['charge', 'wait', 'void'] },
        charge_compartments: { type: 'array', items: { type: 'string' }, description: 'Compartments to charge for' },
        customer_message: { type: 'string', description: 'One or two friendly sentences to the customer' },
        reason: { type: 'string', description: 'Short explanation for the operator log' },
      },
      required: ['action', 'charge_compartments', 'customer_message', 'reason'],
    },
  },
};

const SYSTEM = `You are the handoff agent for LiftDrop, a delivery robot in an office tower.
The customer's PayPal payment is authorized (held). Whatever you do not charge is released.
You decide what to charge from each compartment's two sensors: weight (load cell) and camera (SAM 3.1 on a photo
taken as the doors closed: "gone", "present", "partial" or "unknown" if it couldn't check).
Rules: charge only compartments whose removed=true (weight and camera agree it was emptied). removed="ambiguous" means
the sensors don't add up (item swapped, partly taken, put back, or the camera still sees food): you may "wait" once to
ask the customer, otherwise do not charge it. "void" charges nothing.
Customer message: plain, friendly, amounts in USD. For "charge"/"void" say what was charged and what wasn't.
For "wait" nothing is final yet: ask the customer to check the unclear compartment and close the door; never say
anything was charged.
Always answer by calling decide_handoff exactly once; never reply with plain text.`;

/** Final-sale items (fresh food the shop opted out of refunds for) are charged even when they
 *  weren't collected. Applied by code after every decision, so no proposal can refund them, and
 *  the extra is never more than those items' prices. */
export function keepFinalSale(a: Applied, facts: Fact[]): Applied {
  if (a.action === 'wait') return a;
  const charged = a.action === 'charge' ? a.charge_compartments : [];
  const held = facts.filter((f) => !charged.includes(f.compartment) && f.final_cents > 0);
  if (!held.length) return a;
  const amount = (a.action === 'charge' ? a.amount_cents : 0) + held.reduce((s, f) => s + f.final_cents, 0);
  const taken = facts.filter((f) => charged.includes(f.compartment)).flatMap((f) => f.items);
  const kept = held.flatMap((f) => f.final_items);
  const back = facts.filter((f) => !charged.includes(f.compartment)).flatMap((f) => f.items.filter((i) => !f.final_items.includes(i)));
  const msg = [
    `Charged ${money(amount)}${taken.length ? ` for ${taken.join(', ')}` : ''}.`,
    `${kept.join(', ')} ${kept.length > 1 ? 'are' : 'is'} final sale, so ${kept.length > 1 ? 'they were' : 'it was'} charged even though not collected.`,
    back.length ? `${back.join(', ')} not collected: not charged.` : '',
  ].filter(Boolean).join(' ');
  return { ...a, action: 'charge', charge_compartments: charged, amount_cents: amount, clamped: a.clamped,
    kept: Object.fromEntries(held.map((f) => [f.compartment, f.final_cents])), customer_message: msg,
    reason: `${a.reason} Final sale kept: ${kept.join(', ')}.` };
}

export type Source = 'code' | 'llm' | 'fallback';

/** Clean handoffs (every compartment clearly taken or untouched) are plain arithmetic: decided by
 *  code instantly so the capture lands the moment the bag is lifted. Only unclear ones go to the agent. */
export async function decide(facts: Fact[], waits: number): Promise<{ proposed: Proposal; applied: Applied; source: Source }> {
  const clean = facts.every((f) => f.removed !== 'ambiguous');
  if (clean) {
    const applied = keepFinalSale(fallback(facts, waits), facts);
    return { proposed: applied, applied, source: 'code' };
  }
  if (llmConfigured()) {
    try {
      const proposed = await callTool<Proposal>(SYSTEM, JSON.stringify({ facts, waits_used: waits, max_waits: MAX_WAITS }), TOOL);
      return { proposed, applied: keepFinalSale(clamp(proposed, facts, waits), facts), source: 'llm' };
    } catch (e) {
      console.error('handoff llm failed, using fallback:', e);
    }
  }
  const applied = keepFinalSale(fallback(facts, waits), facts);
  return { proposed: applied, applied, source: 'fallback' };
}
