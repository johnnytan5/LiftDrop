import { authorize } from '../../../lib/orders.ts';
import { respond } from '../_respond.ts';

// Called from the PayPal button's onApprove (or the mock approve button).
export async function POST(req: Request) {
  const { order_id } = (await req.json()) as { order_id: string };
  return respond(() => authorize(String(order_id)));
}
