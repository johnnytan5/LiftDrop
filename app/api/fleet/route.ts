import { beat } from '../../../lib/fleet.ts';
import { respond } from '../_respond.ts';

// Robot heartbeat, once a second from each robot (today: each sim tab).
export async function POST(req: Request) {
  return respond(async () => ({ name: await beat(await req.json()) }));
}
