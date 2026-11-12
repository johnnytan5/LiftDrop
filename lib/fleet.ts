// Live fleet: every robot (a sim tab today, a real robot later) posts a heartbeat once a second.
// ponytail: in-memory in the one server process, like the payout poller; move to a table if the
// API ever runs on more than one instance.

export type Beat = {
  session: string; phase: string; floor: number; x: number; y: number;
  grams: { A: number; B: number }; doors: { A: number; B: number };
  order: string | null; speed: number;
};
export type Robot = Beat & { name: string; online: boolean; first: number; last: number };

const OFFLINE_MS = 5000;
const FORGET_MS = 10 * 60_000; // an offline robot stays listed this long
const MAX_ROBOTS = 20;
type Entry = Beat & { n: number; first: number; last: number };
const g = globalThis as unknown as { __liftdropRobots?: { robots: Map<string, Entry>; seq: number } };
const state = (g.__liftdropRobots ??= { robots: new Map(), seq: 0 }); // survives dev hot reloads
const robots = state.robots;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nameOf = (n: number) => `LD-${String(n).padStart(2, '0')}`;
const pair = (v: unknown) => { const o = (v ?? {}) as Record<string, unknown>; return { A: num(o.A), B: num(o.B) }; };

/** Record a heartbeat. Public endpoint, so every field is coerced and the map is capped. */
export function beat(raw: Record<string, unknown>, now = Date.now()) {
  const session = String(raw.session ?? '').slice(0, 64);
  if (!session) throw new Error('session required');
  const prev = robots.get(session);
  robots.set(session, {
    session, phase: String(raw.phase ?? '').slice(0, 80), floor: num(raw.floor), x: num(raw.x), y: num(raw.y),
    grams: pair(raw.grams), doors: pair(raw.doors),
    order: typeof raw.order === 'string' ? raw.order.slice(0, 40) : null, speed: num(raw.speed),
    n: prev?.n ?? ++state.seq, first: prev?.first ?? now, last: now,
  });
  if (robots.size > MAX_ROBOTS) {
    const oldest = [...robots.values()].sort((a, b) => a.last - b.last)[0];
    robots.delete(oldest.session);
  }
  return nameOf(robots.get(session)?.n ?? 0);
}

/** Robots in the order they first reported, named LD-01, LD-02, … (a number sticks to its robot). */
export function fleet(now = Date.now()): Robot[] {
  for (const r of robots.values()) if (now - r.last > FORGET_MS) robots.delete(r.session);
  return [...robots.values()].sort((a, b) => a.first - b.first)
    .map(({ n, ...r }) => ({ ...r, name: nameOf(n), online: now - r.last < OFFLINE_MS }));
}
