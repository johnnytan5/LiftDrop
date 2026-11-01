// Handoff: sensor state -> facts -> agent proposal -> code-enforced decision.
// The agent may only charge compartments the sensors confirm were emptied; code clamps
// anything else, so a wrong or hostile model can never overcharge.

import type { Compartment, Item, OrderItem } from './db.ts';
import { callTool, llmConfigured, type ToolDef } from './llm.ts';

export type Removed = true | false | 'ambiguous';
export type Fact = {
  compartment: string; shop_id: string; items: string[]; value_cents: number;
  expected_g: number; start_g: number | null; end_g: number | null; door_opened: boolean; removed: Removed;
};
export type Proposal = { action: 'charge' | 'wait' | 'void'; charge_compartments: string[]; customer_message: string; reason: string };
export type Applied = Proposal & { amount_cents: number; clamped: boolean };

// ponytail: fixed ±15% band on the item weight; tune per robot once real touch sensors report.
export const WEIGHT_TOLERANCE = 0.15;
export const MAX_WAITS = 1;

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
  return comps.map((c) => ({
    compartment: c.id, shop_id: c.shop_id, value_cents: c.value_cents, expected_g: c.expected_g,
    start_g: c.start_g, end_g: c.end_g, door_opened: c.door_opened, removed: classify(c),
    items: orderItems.filter((oi) => oi.compartment_id === c.id)
      .map((oi) => `${oi.qty}× ${items.find((i) => i.id === oi.item_id)?.name ?? oi.item_id}`),
  }));
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
    return { action: 'wait', charge_compartments: [], amount_cents: 0, clamped: false,
      customer_message: `Please check compartment ${unsure.map((f) => f.compartment).join(', ')} and close the door.`,
      reason: `Weight change in ${unsure.map((f) => f.compartment).join(', ')} does not match the items; asking the customer.` };
  }
  if (!taken.length) {
    return { action: 'void', charge_compartments: [], amount_cents: 0, clamped: false,
      customer_message: 'Not delivered, not charged.', reason: 'No compartment confirmed empty.' };
  }
  const amount = cap(facts);
  return { action: 'charge', charge_compartments: taken.map((f) => f.compartment), amount_cents: amount, clamped: false,
    customer_message: left.length
      ? `Charged ${money(amount)} for ${names(taken)}. ${names(left)} not collected, not charged.`
      : `Charged ${money(amount)}. Enjoy!`,
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
The customer's PayPal payment is authorized (held). You decide what to charge from the robot's compartment sensors.
Rules: charge only compartments whose removed=true. removed="ambiguous" means the weight change doesn't match the item
(e.g. item swapped, partly taken, put back): you may "wait" once to ask the customer, otherwise do not charge it.
"void" charges nothing. Customer message: plain, friendly, amounts in USD. For "charge"/"void" say what was charged
and what wasn't. For "wait" NOTHING has been charged yet: ask the customer to check the unclear compartment and close
the door; never say anything was charged.
Always answer by calling decide_handoff exactly once; never reply with plain text.`;

export type Source = 'code' | 'llm' | 'fallback';

/** Clean handoffs (every compartment clearly taken or untouched) are plain arithmetic: decided by
 *  code instantly so the capture lands the moment the bag is lifted. Only unclear ones go to the agent. */
export async function decide(facts: Fact[], waits: number): Promise<{ proposed: Proposal; applied: Applied; source: Source }> {
  const clean = facts.every((f) => f.removed !== 'ambiguous');
  if (clean) {
    const applied = fallback(facts, waits);
    return { proposed: applied, applied, source: 'code' };
  }
  if (llmConfigured()) {
    try {
      const proposed = await callTool<Proposal>(SYSTEM, JSON.stringify({ facts, waits_used: waits, max_waits: MAX_WAITS }), TOOL);
      return { proposed, applied: clamp(proposed, facts, waits), source: 'llm' };
    } catch (e) {
      console.error('handoff llm failed, using fallback:', e);
    }
  }
  const applied = fallback(facts, waits);
  return { proposed: applied, applied, source: 'fallback' };
}
