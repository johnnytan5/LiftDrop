import { snapshot } from '../../../lib/db.ts';
import { expireUnclaimed, syncPendingPayouts } from '../../../lib/orders.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  await syncPendingPayouts(); // no-op when already watched
  await expireUnclaimed().catch((e) => console.error('expire unclaimed:', e));
  return Response.json(await snapshot());
}
