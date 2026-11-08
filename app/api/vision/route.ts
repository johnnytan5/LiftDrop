// Compartment camera check: SAM 3.1 looks for each dish in the photo. Dishes whose call failed
// are reported as failed and never count as taken. With an order, the result is stored on the
// compartment ('before' as the doors open, 'after' as they close) for the handoff to use.
// Adapted from MuseConcierge app/api/vision (cabin check).
import { segment } from '../../../lib/llm.ts';
import { assignBoxes, PACK, parseBoxes, PROMPTS, slots, type Box, type CameraCheck } from '../../../lib/vision.ts';
import * as db from '../../../lib/db.ts';

const MAX_IMAGE_CHARS = 1_500_000; // a 640x480 JPEG is ~60 KB
const TIMEOUT_MS = 15000;

async function check(image: string, lines: { item_id: string; qty: number }[]): Promise<CameraCheck> {
  const t0 = Date.now();
  const items = [...new Set(lines.map((l) => l.item_id))];
  // One SAM call per prompt, shared by every dish that uses it (two cups -> one 'cup' call).
  const prompts = [...new Set(items.flatMap((id) => PROMPTS[PACK[id]] ?? []))];
  const answers = Object.fromEntries(await Promise.all(prompts.map(async (p) => {
    try { return [p, parseBoxes(await segment(p, image, TIMEOUT_MS))] as const; } catch { return [p, null] as const; }
  })));
  const candidates: Record<string, Box[]> = {};
  const failed: string[] = [];
  for (const slot of slots(lines)) {
    const ps = PROMPTS[PACK[slot.split('#')[0]]] ?? [];
    if (!ps.length || ps.some((p) => answers[p] === null)) { failed.push(slot); continue; }
    candidates[slot] = ps.flatMap((p) => answers[p]!);
  }
  return { found: assignBoxes(candidates), failed, ms: Date.now() - t0, at: new Date().toISOString() };
}

export async function POST(req: Request) {
  const body = (await req.json()) as { image?: string; order_id?: string; compartment?: string; when?: 'before' | 'after'; items?: { item_id: string; qty: number }[] };
  const { image } = body;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(image) || image.length > MAX_IMAGE_CHARS) {
    return Response.json({ error: 'bad image' }, { status: 400 });
  }
  try {
    // Prompt probe (/camera-check?probe): raw SAM boxes for each candidate prompt.
    const probe = (body as { probe?: unknown }).probe;
    if (!body.order_id && Array.isArray(probe)) {
      const ps = probe.map(String).slice(0, 12);
      return Response.json(Object.fromEntries(await Promise.all(ps.map(async (p) => {
        try { return [p, parseBoxes(await segment(p, image, TIMEOUT_MS)).map((b) => +b.c.toFixed(2))]; } catch (e) { return [p, String(e).slice(0, 60)]; }
      }))));
    }
    // Bench mode (/camera-check): just the dishes named, nothing stored.
    if (!body.order_id) {
      const lines = (body.items ?? []).filter((l) => PACK[l.item_id]).slice(0, 6);
      if (!lines.length) return Response.json({ error: 'no known dishes' }, { status: 400 });
      return Response.json(await check(image, lines));
    }
    if (body.when !== 'before' && body.when !== 'after') return Response.json({ error: 'when must be before or after' }, { status: 400 });
    const [order, comps, orderItems] = await Promise.all([db.getOrder(body.order_id), db.getCompartments(body.order_id), db.getOrderItems(body.order_id)]);
    if (order.status !== 'at_door') return Response.json({ error: `order is ${order.status}, not at the door` }, { status: 409 });
    if (!comps.some((c) => c.id === body.compartment)) return Response.json({ error: `no compartment ${body.compartment}` }, { status: 400 });
    const result = await check(image, orderItems.filter((l) => l.compartment_id === body.compartment));
    await db.updateCompartment(order.id, body.compartment!, body.when === 'before' ? { vision_before: result } : { vision_after: result });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : 'vision failed' }, { status: 502 });
  }
}
