// OpenAI chat-completions client for Muse Spark or OpenRouter (same wire format).
// Adapted from MuseConcierge lib/meta/client.ts. Server-side only.

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AssistantMessage = { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const base = () => process.env.LLM_BASE_URL ?? 'https://api.meta.ai/v1';
const isOpenRouter = () => base().includes('openrouter.ai');
// OpenRouter uses its own key so switching provider is just LLM_BASE_URL + LLM_MODEL.
const apiKey = () => (isOpenRouter() ? process.env.OPENROUTER_API_KEY : process.env.LLM_API_KEY);

export const llmConfigured = () => !!apiKey();

// The phone call always runs on Muse Spark, whatever LLM_BASE_URL says for the handoff agent.
const SPARK = { base: 'https://api.meta.ai/v1', key: () => process.env.META_API_KEY || process.env.LLM_API_KEY, model: () => process.env.SPARK_MODEL ?? 'muse-spark-1.1' };
export const sparkConfigured = () => !!SPARK.key();

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
  spark?: boolean;
}): Promise<AssistantMessage> {
  const openRouter = !opts.spark && isOpenRouter();
  const res = await fetch(`${opts.spark ? SPARK.base : base()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.spark ? SPARK.key() : apiKey()}` },
    body: JSON.stringify({
      model: opts.spark ? SPARK.model() : process.env.LLM_MODEL ?? 'muse-spark-1.1',
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // Low reasoning keeps the handoff fast: gpt-6-luna ~2 s at minimal vs ~5 s default;
      // Muse still reasons 500-900 tokens (~4-6 s) even at minimal.
      ...(openRouter ? { reasoning: { effort: 'minimal' } } : { reasoning_effort: 'minimal' }),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`llm ${res.status}: ${body.slice(0, 200)}`);
  const choice = JSON.parse(body).choices[0];
  if (!choice.message.content && !choice.message.tool_calls?.length) {
    throw new Error(`llm returned an empty message (finish_reason ${choice.finish_reason})`);
  }
  return choice.message;
}

/** Call once, expect a call of `tool`, return its parsed arguments.
 *  Muse only accepts tool_choice "auto", so the system prompt must demand the call. */
export async function callTool<T>(system: string, user: string, tool: ToolDef): Promise<T> {
  const msg = await chat({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // Muse reasoning counts against max_tokens; 600 ran out (finish_reason length).
    tools: [tool], maxTokens: 2000,
  });
  const call = msg.tool_calls?.find((c) => c.function.name === tool.function.name);
  if (!call) throw new Error(`llm did not call ${tool.function.name}`);
  return JSON.parse(call.function.arguments) as T;
}

/** SAM 3.1 on Meta's Responses endpoint: a text prompt plus an image, answered with
 *  <|box;...|> markers in the output text (parsed by lib/vision.ts). From MuseConcierge. */
export async function segment(prompt: string, imageDataUrl: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(`${SPARK.base}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SPARK.key()}` },
    body: JSON.stringify({
      model: process.env.SAM_MODEL ?? 'sam-3.1',
      stream: false,
      metadata: { include_confidence: 'true' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`sam ${res.status}: ${body.slice(0, 200)}`);
  const j = JSON.parse(body);
  return j.output_text ?? (j.output ?? []).flatMap((o: { content?: { text?: string }[] }) => o.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
}
