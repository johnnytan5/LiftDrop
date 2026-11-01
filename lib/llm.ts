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

export const llmConfigured = () => !!process.env.LLM_API_KEY;

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<AssistantMessage> {
  const base = process.env.LLM_BASE_URL ?? 'https://api.meta.ai/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? 'muse-spark-1.1',
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // Muse-specific; OpenRouter ignores it. Keeps the handoff decision fast.
      ...(base.includes('meta.ai') ? { reasoning_effort: 'minimal' } : {}),
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
