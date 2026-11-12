// One Muse Spark turn of the order call. Stateless: the browser keeps the conversation and
// runs the tools against the basket; this adds the system prompt and keeps the key here.
// Adapted from MuseConcierge app/api/agent.
import { chat, sparkConfigured, type ChatMessage } from '../../../lib/llm.ts';
import { TOOL_DEFS, basketView, type Caller, type Cart } from '../../../lib/call/tools.ts';
import { callPrompt } from '../../../lib/call/prompt.ts';
import * as db from '../../../lib/db.ts';

const MAX_MESSAGES = 60; // a short food order; caps cost per request
const MAX_CHARS = 4000;

export async function POST(req: Request) {
  if (!sparkConfigured()) return Response.json({ error: 'The order line is offline (no Muse Spark key).' }, { status: 503 });
  const { messages, cart, caller } = (await req.json()) as { messages?: ChatMessage[]; cart?: Cart; caller?: Partial<Caller> };
  // Goes into the system prompt: keep it to a short plain name and a real floor.
  const who: Caller = { name: String(caller?.name ?? '').replace(/[^\p{L} .'-]/gu, '').slice(0, 40).trim() || 'the caller', floor: caller?.floor === 20 ? 20 : 23 };
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES
    || messages.some((m) => m.role === 'system' || JSON.stringify(m).length > MAX_CHARS)) {
    return Response.json({ error: 'bad messages' }, { status: 400 });
  }
  const t0 = Date.now();
  try {
    const [items, shops] = await Promise.all([db.listItems(), db.listShops()]);
    const safeCart = Object.fromEntries(Object.entries(cart ?? {}).filter(([id, q]) => items.some((i) => i.id === id) && Number(q) > 0));
    const message = await chat({
      spark: true,
      messages: [{ role: 'system', content: callPrompt(items, shops, basketView(items, shops, safeCart), who) }, ...messages],
      tools: TOOL_DEFS,
      maxTokens: 1000,
      timeoutMs: 15000,
    });
    return Response.json({ message, ms: Date.now() - t0 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : 'call agent failed' }, { status: 502 });
  }
}
