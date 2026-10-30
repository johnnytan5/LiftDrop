import { resetDb } from '../../../lib/db.ts';
import { resetMock } from '../../../lib/paypal.ts';

// ponytail: mock-only demo reset; remove or guard once Supabase holds real sandbox data.
export async function POST() {
  if (process.env.PAYPAL_MODE === 'sandbox') return Response.json({ error: 'disabled in sandbox mode' }, { status: 403 });
  resetDb();
  resetMock();
  return Response.json({ ok: true });
}
