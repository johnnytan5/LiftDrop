import { snapshot } from '../../../lib/db.ts';
import { syncPendingPayouts } from '../../../lib/orders.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  await syncPendingPayouts(); // no-op when already watched
  return Response.json(await snapshot());
}
