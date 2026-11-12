import { timingSafeEqual } from 'node:crypto';
import * as db from '../../../lib/db.ts';
import { fleet } from '../../../lib/fleet.ts';
import { escalations } from '../../../lib/ops.ts';
import { opsCancel, opsRelease, opsResolve, opsSettle } from '../../../lib/orders.ts';
import { respond } from '../_respond.ts';

export const dynamic = 'force-dynamic';

// Live fleet, the escalation queue, and the recent orders, for /ops.
export async function GET() {
  return respond(async () => {
    const s = await db.snapshot();
    const events = await db.listEvents(s.orders.map((o) => o.id), ['error', 'ops']);
    const robots = await fleet();
    return { robots, escalations: escalations(s, events, robots), orders: s.orders, compartments: s.compartments, ledger: s.ledger, shops: s.shops, ops: events.filter((e) => e.type === 'ops') };
  });
}

// Operator actions move money. Open by default for the demo; set OPS_TOKEN (sent as x-ops-token)
// to lock them on a public deploy.
function allowed(req: Request) {
  const want = process.env.OPS_TOKEN;
  if (!want) return true;
  const got = Buffer.from(req.headers.get('x-ops-token') ?? '');
  const exp = Buffer.from(want);
  return got.length === exp.length && timingSafeEqual(got, exp);
}

export async function POST(req: Request) {
  if (!allowed(req)) return Response.json({ error: 'operator token required' }, { status: 401 });
  const b = (await req.json()) as { action?: string; order_id?: string; charge?: unknown; note?: string };
  const id = String(b.order_id ?? '');
  const note = String(b.note ?? '').slice(0, 200);
  return respond(async () => {
    if (b.action === 'settle') return opsSettle(id, Array.isArray(b.charge) ? b.charge.map(String).filter((c) => c === 'A' || c === 'B') : [], note);
    if (b.action === 'cancel') return opsCancel(id, note);
    if (b.action === 'release') return opsRelease(id, note);
    if (b.action === 'resolve') return opsResolve(id, note);
    throw new Error(`unknown action ${b.action}`);
  });
}
