import * as db from '../../../../lib/db.ts';
import { claim, customerDone, isUnlocked, unlock, vendorLoaded } from '../../../../lib/orders.ts';
import { respond } from '../../_respond.ts';
import { CODE_WAIT_S } from '../../../../lib/sim/tower.ts';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

// One order for the phone: status, compartments, what it contains and where the money is.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(async () => {
    const [order, compartments, order_items, ledger, items, decisions, unlocked] = await Promise.all([
      db.getOrder(id), db.getCompartments(id), db.getOrderItems(id), db.listLedger(id), db.listItems(), db.listDecisions(id), isUnlocked(id),
    ]);
    // The robot waits CODE_WAIT_S at the gate for the code; the phone counts down to this.
    const arrived = order.status === 'at_door' ? (await db.listEvents([id], ['arrived'])).at(-1) : undefined;
    const code_deadline = arrived ? new Date(Date.parse(arrived.at) + CODE_WAIT_S * 1000).toISOString() : null;
    const last = decisions.at(-1);
    const decision = last ? { ...(last.applied as { action: string; charge_compartments: string[] }), at: last.at } : null;
    return { order, compartments, ledger, decision, unlocked, code_deadline, lines: order_items.map((l) => ({ ...l, name: items.find((i) => i.id === l.item_id)?.name ?? l.item_id })) };
  });
}

// { action: 'done' } from the phone, { action: 'loaded', compartment } from the shop,
// { action: 'claim', session } from the sim tab that will drive the robot,
// { action: 'unlock', code } from the robot's screen at the gate.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json()) as { action?: string; compartment?: string; session?: string; code?: string };
  return respond(async () => {
    if (body.action === 'done') return customerDone(id);
    if (body.action === 'loaded') return vendorLoaded(id, String(body.compartment));
    if (body.action === 'unlock') return unlock(id, String(body.code ?? ''));
    if (body.action === 'claim') return claim(id, String(body.session ?? ''));
    throw new Error(`unknown action ${body.action}`);
  });
}
