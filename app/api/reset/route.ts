import { resetDb } from '../../../lib/db.ts';
import { resetMock } from '../../../lib/paypal.ts';
import { respond } from '../_respond.ts';

// Mock-only demo reset (resetDb refuses when Supabase is the backend).
export async function POST() {
  return respond(async () => {
    if (process.env.PAYPAL_MODE === 'sandbox') throw new Error('disabled in sandbox mode');
    resetDb();
    resetMock();
    return { ok: true };
  });
}
