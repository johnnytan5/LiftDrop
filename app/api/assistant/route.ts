import { suggestCart } from '../../../lib/assistant.ts';
import { respond } from '../_respond.ts';

export async function POST(req: Request) {
  const { message } = (await req.json()) as { message?: string };
  return respond(() => suggestCart(String(message ?? '').slice(0, 300)));
}
