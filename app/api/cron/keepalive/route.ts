import { timingSafeEqual } from 'node:crypto';
import * as db from '../../../../lib/db.ts';
import { expireUnclaimed, syncPendingPayouts } from '../../../../lib/orders.ts';

export const dynamic = 'force-dynamic';

// Vercel Cron (vercel.json) calls this once a day. Supabase's free tier pauses a project after a
// week without activity, which would take the demo down, so this does real reads and writes:
// it reads the menu and orders, cancels paid orders no robot finished (releasing the PayPal hold),
// syncs shop payouts still processing, and forgets robots that stopped reporting.
// Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set; then nothing else may call it.
function allowed(req: Request) {
  const want = process.env.CRON_SECRET;
  if (!want) return true;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const exp = Buffer.from(`Bearer ${want}`);
  return got.length === exp.length && timingSafeEqual(got, exp);
}

export async function GET(req: Request) {
  if (!allowed(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!db.usingSupabase()) return Response.json({ ok: true, note: 'no Supabase configured: nothing to keep awake' });
  const now = Date.now();
  try {
    const [shops, items, orders] = await Promise.all([db.listShops(), db.listItems(), db.listOrders()]);
    await expireUnclaimed(now, true);
    await syncPendingPayouts(now);
    await db.deleteRobotsBefore(now - 60 * 60_000);
    const robots = await db.listRobots();
    const out = { ok: true, at: new Date(now).toISOString(), shops: shops.length, items: items.length, orders: orders.length, robots: robots.length };
    console.log('keepalive', out);
    return Response.json(out);
  } catch (e) {
    console.error('keepalive failed', e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
