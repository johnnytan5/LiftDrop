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

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<AssistantMessage> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? 'muse-spark-1.1',
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // Low reasoning keeps the handoff fast: gpt-6-luna ~2 s at minimal vs ~5 s default;
      // Muse still reasons 500-900 tokens (~4-6 s) even at minimal.
      ...(isOpenRouter() ? { reasoning: { effort: 'minimal' } } : { reasoning_effort: 'minimal' }),
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
