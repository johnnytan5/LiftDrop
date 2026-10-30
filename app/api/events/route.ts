import { handleEvent, type SensorEvent } from '../../../lib/orders.ts';
import { respond } from '../_respond.ts';

const TYPES = ['loaded', 'arrived', 'door_opened', 'weight', 'door_closed', 'timeout'];

// Robot sim, fake buttons and fault injection all post here: { order_id, type, ...fields }.
export async function POST(req: Request) {
  const { order_id, ...ev } = (await req.json()) as { order_id: string } & SensorEvent;
  return respond(async () => {
    if (!TYPES.includes(ev.type)) throw new Error(`unknown event type ${ev.type}`);
    if (ev.type === 'weight' && !(Number.isFinite(ev.grams) && ev.grams >= 0)) throw new Error('weight needs grams >= 0');
    return handleEvent(String(order_id), ev);
  });
}
