import * as db from '../../../../lib/db.ts';
import { claim, customerDone, vendorLoaded } from '../../../../lib/orders.ts';
import { respond } from '../../_respond.ts';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

// One order for the phone: status, compartments, what it contains and where the money is.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(async () => {
    const [order, compartments, order_items, ledger, items, decisions] = await Promise.all([
      db.getOrder(id), db.getCompartments(id), db.getOrderItems(id), db.listLedger(id), db.listItems(), db.listDecisions(id),
    ]);
    const last = decisions.at(-1);
    const decision = last ? { ...(last.applied as { action: string; charge_compartments: string[] }), at: last.at } : null;
    return { order, compartments, ledger, decision, lines: order_items.map((l) => ({ ...l, name: items.find((i) => i.id === l.item_id)?.name ?? l.item_id })) };
  });
}

// { action: 'done' } from the phone, { action: 'loaded', compartment } from the shop,
// { action: 'claim', session } from the sim tab that will drive the robot.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json()) as { action?: string; compartment?: string; session?: string };
  return respond(async () => {
    if (body.action === 'done') return customerDone(id);
    if (body.action === 'loaded') return vendorLoaded(id, String(body.compartment));
    if (body.action === 'claim') return claim(id, String(body.session ?? ''));
    throw new Error(`unknown action ${body.action}`);
  });
}
