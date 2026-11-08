// One order call: caller turns in, spoken replies out. The browser keeps the history and runs
// the tools against the basket; /api/call does the Muse Spark turn. From MuseConcierge
// lib/agent/session.ts, cut down to what an order line needs.
import type { AssistantMessage, ChatMessage } from '../llm.ts';
import { runTool, type CallCtx } from './tools.ts';

const MAX_TOOL_ROUNDS = 4; // stops a model that keeps calling tools from looping
const GOODBYE = 'Thanks for ordering with LiftDrop. Bye!';
// The caller is clearly done. Spark sometimes asks "anything else?" again instead of checking out.
const READY = /\b(that'?s (all|everything|it)|that is (all|everything|it)|nothing else|(i'?d like to|i want to|let me|ready to) pay|pay now|check ?out|send (the|my) robot)\b/i;
const TAP = 'Tap Approve in PayPal on your screen. PayPal only holds the money; you pay just for what you take out of the robot.';

export type CallLog =
  | { kind: 'caller'; text: string }
  | { kind: 'agent'; text: string; ms: number }
  | { kind: 'tool'; name: string; args: unknown; result: object }
  | { kind: 'error'; text: string };

export class CallSession {
  messages: ChatMessage[] = [];
  ended = false;
  checkedOut = false;
  finalLine: string | null = null;
  queue: Promise<void> = Promise.resolve();
  speech: Promise<void> = Promise.resolve();
  ctx: CallCtx;
  hooks: { onSay(text: string): Promise<void>; onEnd(): void; onLog(e: CallLog): void; onThinking?(on: boolean): void; onHush?(): void; url?: string };

  constructor(ctx: CallCtx, hooks: CallSession['hooks']) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  /** The line speaks first; the greeting goes into the history so Spark knows what it said. */
  greet(text: string) {
    this.messages.push({ role: 'assistant', content: text });
    this.say(text, 0);
  }

  // Turns run one at a time, in order, even if the caller speaks while the agent thinks.
  onCaller(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.turn(text)).catch((e) => {
      this.hooks.onLog({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }).finally(() => this.hooks.onThinking?.(false));
    return this.queue;
  }

  /** The caller approved in PayPal: say a fixed line and hang up, without waiting for a Spark
   *  turn still in flight (its lines are dropped once the call has ended). */
  finish(text: string) {
    this.finalLine = text; // queued lines that haven't started are skipped; this one is said next
    this.hooks.onHush?.(); // and the one being said is cut off
    this.say(text, 0);
    void this.speech.then(() => this.end());
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.hooks.onEnd();
  }

  async turn(text: string) {
    if (this.ended) return;
    this.hooks.onLog({ kind: 'caller', text });
    this.messages.push({ role: 'user', content: text });
    this.hooks.onThinking?.(true);
    let hangUp = false;
    let spoke = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { message, ms } = await this.complete();
      this.messages.push(message);
      // Spark narrates its tool calls ("I'll add that now", "ending the call") and then says the
      // result again; only the line after the tools is spoken.
      if (this.ended) return;
      const line = message.tool_calls?.length ? '' : message.content?.trim();
      if (line) { this.say(line, ms); spoke = true; }
      if (!message.tool_calls?.length) break;
      for (const call of message.tool_calls) {
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* the tool reports bad args */ }
        const result = runTool(call.function.name, args, this.ctx);
        this.hooks.onLog({ kind: 'tool', name: call.function.name, args, result });
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (call.function.name === 'end_call') hangUp = true;
        if (call.function.name === 'checkout' && !('error' in result)) this.checkedOut = true;
      }
      if (hangUp) break;
    }
    this.hooks.onThinking?.(false);
    if (!hangUp && !this.checkedOut && READY.test(text) && Object.keys(this.ctx.getCart()).length) {
      const result = runTool('checkout', {}, this.ctx);
      this.hooks.onLog({ kind: 'tool', name: 'checkout', args: { by: 'code: caller said they were done' }, result });
      if (!('error' in result)) {
        this.checkedOut = true;
        this.speech = Promise.resolve(); // don't make them wait for "anything else?" to finish
        this.hooks.onHush?.();
        this.messages.push({ role: 'assistant', content: TAP });
        this.say(TAP, 0);
      }
    }
    if (hangUp && !spoke) this.say(GOODBYE, 0);
    await this.speech;
    if (hangUp) this.end();
  }

  // Speech is queued, not awaited: tools and the next model call run while the line talks.
  say(line: string, ms: number) {
    this.hooks.onLog({ kind: 'agent', text: line, ms });
    this.speech = this.speech.then(() => (this.finalLine && line !== this.finalLine ? undefined : this.hooks.onSay(line)));
  }

  async complete(): Promise<{ message: AssistantMessage; ms: number }> {
    const res = await fetch(this.hooks.url ?? '/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: this.messages, cart: this.ctx.getCart() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `call ${res.status}`);
    return body;
  }
}
