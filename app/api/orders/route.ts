import { createOrder, type CartLine } from '../../../lib/orders.ts';
import { respond } from '../_respond.ts';

// The robot stops outside the security gate of one of the two office floors it serves.
const LOCATIONS = ['L20-gate', 'L23-gate'];

export async function POST(req: Request) {
  const body = (await req.json()) as { location?: string; cart?: CartLine[] };
  // Always pay on delivery: PayPal holds the total and captures only what's taken. (The pay-now
  // path in lib/orders.ts stays for orders placed before it was retired.)
  return respond(() => createOrder(LOCATIONS.includes(body.location as string) ? body.location! : 'L23-gate', Array.isArray(body.cart) ? body.cart : []));
}
