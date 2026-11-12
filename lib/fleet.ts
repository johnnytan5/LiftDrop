// Live fleet: every robot (a sim tab today, a real robot later) posts a heartbeat once a second.
// Stored in the robots table (in-memory without Supabase), so it works when the API runs as
// several serverless instances that share no memory.

import * as db from './db.ts';

export type Beat = {
  session: string; phase: string; floor: number; x: number; y: number;
  grams: { A: number; B: number }; doors: { A: number; B: number };
  order: string | null; speed: number;
};
export type Robot = Beat & { name: string; online: boolean; first: number; last: number };

const OFFLINE_MS = 5000;
const FORGET_MS = 10 * 60_000; // an offline robot stays listed this long
const MAX_ROBOTS = 20;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nameOf = (n: number) => `LD-${String(n).padStart(2, '0')}`;
const pair = (v: unknown) => { const o = (v ?? {}) as Record<string, unknown>; return { A: num(o.A), B: num(o.B) }; };

/** Record a heartbeat. Public endpoint, so every field is coerced. */
export async function beat(raw: Record<string, unknown>, now = Date.now()) {
  const session = String(raw.session ?? '').slice(0, 64);
  if (!session) throw new Error('session required');
  const b: Beat = {
    session, phase: String(raw.phase ?? '').slice(0, 80), floor: num(raw.floor), x: num(raw.x), y: num(raw.y),
    grams: pair(raw.grams), doors: pair(raw.doors),
    order: typeof raw.order === 'string' ? raw.order.slice(0, 40) : null, speed: num(raw.speed),
  };
  return nameOf(await db.upsertRobot(session, b, now));
}

/** Robots in the order they first reported, named LD-01, LD-02, … (a number sticks to its robot). */
export async function fleet(now = Date.now()): Promise<Robot[]> {
  await db.deleteRobotsBefore(now - FORGET_MS);
  const rows = (await db.listRobots()).filter((r) => now - r.last <= FORGET_MS)
    .sort((a, b) => b.last - a.last).slice(0, MAX_ROBOTS); // ponytail: cap on read; spam rows age out after FORGET_MS
  return rows.sort((a, b) => a.first - b.first)
    .map((r) => ({ ...(r.beat as Beat), session: r.session, name: nameOf(r.n), online: now - r.last < OFFLINE_MS, first: r.first, last: r.last }));
}
