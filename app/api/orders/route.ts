import { createOrder, type CartLine } from '../../../lib/orders.ts';
import { respond } from '../_respond.ts';

export async function POST(req: Request) {
  const body = (await req.json()) as { location?: string; cart?: CartLine[] };
  return respond(() => createOrder(String(body.location ?? 'L23-pantry').slice(0, 40), Array.isArray(body.cart) ? body.cart : []));
}
