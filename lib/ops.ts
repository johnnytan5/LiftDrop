// Operations view: the live fleet and the escalation queue (what needs a person), computed from
// the same snapshot the consoles read plus the fleet heartbeats. Pure, so it's testable.
import type { Compartment, Decision, Event, LedgerRow, Order } from './db.ts';
import type { Applied, Fact } from './handoff.ts';
import type { Robot } from './fleet.ts';
import { seen } from './vision.ts';

export type OpsAction = 'settle' | 'cancel' | 'release' | 'resolve';
export type Escalation = {
  order_id: string; kind: 'customer_check' | 'robot_offline' | 'unclaimed' | 'overdue' | 'failed' | 'ai_review';
  severity: 'urgent' | 'review'; title: string; detail: string[]; since: string; actions: OpsAction[];
};

export const UNCLAIMED_ALERT_MS = 2 * 60_000; // a trip takes ~2 min; nobody claiming it for 2 is worth a look
export const OVERDUE_MS = 10 * 60_000;
const ACTIVE = ['held', 'collecting', 'en_route', 'at_door'];
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/** One line per compartment: what the scale and the camera said. */
export function sensorLines(facts: unknown, comps: Compartment[]): string[] {
  const f = Array.isArray(facts) ? (facts as Fact[]) : [];
  return comps.map((c) => {
    const x = f.find((y) => y.compartment === c.id);
    const g = x?.end_g ?? c.end_g;
    const cam = x?.camera ?? seen(c.vision_after);
    return `${c.id} (${usd(c.value_cents)}): scale ${g === null || g === undefined ? 'no reading' : `${g} g of ${c.expected_g} g`}, camera ${cam === 'gone' ? 'saw it gone' : cam === 'present' ? 'still sees it' : cam === 'partial' ? 'sees part of it' : 'unsure'}`;
  });
}

export function escalations(s: { orders: Order[]; compartments: Compartment[]; decisions: Decision[]; ledger: LedgerRow[] }, events: Event[], robots: Robot[], now = Date.now()): Escalation[] {
  const out: Escalation[] = [];
  for (const o of s.orders) {
    const comps = s.compartments.filter((c) => c.order_id === o.id);
    const decisions = s.decisions.filter((d) => d.order_id === o.id);
    const last = decisions.at(-1);
    const applied = last?.applied as Applied | undefined;
    const age = now - Date.parse(o.created_at);
    const robot = robots.find((r) => r.session === o.robot_session);
    const where = `Level ${o.location.startsWith('L20') ? 20 : 23} · ${usd(o.total_cents)} on hold`;
    const push = (e: Omit<Escalation, 'order_id' | 'detail'> & { detail?: string[] }) => out.push({ order_id: o.id, ...e, detail: [where, ...(e.detail ?? [])] });

    if (o.status === 'at_door' && applied?.action === 'wait') {
      push({ kind: 'customer_check', severity: 'urgent', title: 'Scale and camera disagree at the gate', since: last!.at,
        detail: [`Agent asked the customer: “${applied.customer_message}”`, ...sensorLines(last!.facts, comps)], actions: ['settle'] });
    } else if (ACTIVE.includes(o.status) && o.robot_session && robot && !robot.online) {
      push({ kind: 'robot_offline', severity: 'urgent', title: `${robot.name} went offline mid-delivery`, since: new Date(robot.last).toISOString(),
        detail: [`Last seen: ${robot.phase || 'unknown'}`], actions: o.status === 'at_door' ? ['settle'] : ['cancel'] });
    } else if (o.status === 'held' && !o.robot_session && age > UNCLAIMED_ALERT_MS) {
      push({ kind: 'unclaimed', severity: 'urgent', title: 'Paid, but no robot has taken it', since: o.created_at,
        detail: [robots.some((r) => r.online) ? 'Robots are online but busy.' : 'No robot is online.', 'Auto-cancels at 15 min.'], actions: ['cancel'] });
    } else if (ACTIVE.includes(o.status) && age > OVERDUE_MS) {
      push({ kind: 'overdue', severity: 'urgent', title: 'Delivery is taking too long', since: o.created_at,
        detail: [`${Math.round(age / 60_000)} min since the order; ${robot ? `${robot.name}: ${robot.phase}` : 'no robot reporting'}`], actions: o.status === 'at_door' ? ['settle'] : ['cancel'] });
    } else if (o.status === 'failed') {
      const err = events.filter((e) => e.order_id === o.id && e.type === 'error').at(-1);
      push({ kind: 'failed', severity: 'urgent', title: 'Order failed', since: err?.at ?? o.created_at,
        detail: [String(err?.payload.message ?? 'No error recorded.'), `Ledger: ${s.ledger.filter((l) => l.order_id === o.id).map((l) => `${l.kind} ${usd(l.amount_cents)}`).join(', ') || 'nothing moved'}`],
        actions: o.captured_cents ? ['resolve'] : ['release', 'resolve'] }); // release only while no money has moved
    } else if (last && last.source !== 'code' && last.source !== 'operator' && applied?.action !== 'wait') {
      const proposed = last.proposed as Applied;
      push({ kind: 'ai_review', severity: 'review', title: applied?.clamped ? 'Code overruled the AI’s charge' : 'AI settled an unclear handoff', since: last.at,
        detail: [`${last.source === 'llm' ? 'Muse Spark' : 'Fallback rule'}: ${last.reason}`,
          ...(applied?.clamped ? [`AI proposed ${proposed.action} ${proposed.charge_compartments?.join(', ') || '—'}; applied ${applied.action} ${usd(applied.amount_cents)}`] : [`Applied: ${applied?.action} ${usd(applied?.amount_cents ?? 0)}`]),
          ...sensorLines(last.facts, comps)],
        actions: ['resolve'] });
    }
  }
  // Anything an operator already resolved (after it was raised) drops off the queue.
  const resolved = (e: Escalation) => events.some((x) => x.order_id === e.order_id && x.type === 'ops' && x.payload.action === 'resolve' && Date.parse(x.at) >= Date.parse(e.since));
  return out.filter((e) => !resolved(e)).sort((a, b) => (a.severity === b.severity ? Date.parse(a.since) - Date.parse(b.since) : a.severity === 'urgent' ? -1 : 1));
}
