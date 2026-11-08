// Mic -> 16 kHz PCM16 frames -> AssemblyAI Universal-Streaming v3. The browser connects with a
// short-lived token from /api/asr-token. Adapted from MuseConcierge lib/voice (AssemblyAI path).
import type { Gate } from './gate.ts';

export type AsrHandlers = { onPartial(t: string): void; onFinal(t: string): void; onError(msg: string): void };

async function connect(keywords: string[], h: AsrHandlers) {
  const res = await fetch('/api/asr-token');
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `asr token ${res.status}`);
  const qs = new URLSearchParams({
    sample_rate: '16000', encoding: 'pcm_s16le', format_turns: 'true',
    keyterms_prompt: JSON.stringify(keywords), token: j.token,
  });
  return new Promise<{ send(f: ArrayBuffer): void; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${qs}`);
    let ready = false;
    let closing = false; // we hung up; the socket closing after that is not an error
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'Begin') {
        ready = true;
        resolve({
          send: (f) => { if (ws.readyState === WebSocket.OPEN) ws.send(f); },
          close: () => {
            closing = true;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' }));
            setTimeout(() => ws.close(), 500);
          },
        });
      } else if (m.type === 'Turn') {
        // An unformatted end_of_turn is followed by the formatted one; use that.
        if (m.end_of_turn && m.turn_is_formatted) { if (m.transcript.trim()) h.onFinal(m.transcript.trim()); }
        else if (!m.end_of_turn) h.onPartial(m.transcript);
      } else if (m.error) h.onError(m.error);
    };
    ws.onerror = () => { if (!ready) reject(new Error('cannot reach AssemblyAI')); };
    ws.onclose = (ev) => { if (ready && !closing && ev.code !== 1000) h.onError(`transcriber closed (${ev.code} ${ev.reason})`); };
  });
}

export async function openAsr(opts: AsrHandlers & { stream: MediaStream; keywords: string[]; gate: Gate; muted(): boolean }) {
  const conn = await connect(opts.keywords, opts);
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/voice/mic-worklet.js');
  const src = ctx.createMediaStreamSource(opts.stream);
  const node = new AudioWorkletNode(ctx, 'mic-pcm16');
  // While the line speaks (echo) or the caller muted, send silence rather than nothing, so the
  // stream keeps real-time pace.
  node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) =>
    conn.send(opts.gate.shouldSend() && !opts.muted() ? ev.data : new ArrayBuffer(ev.data.byteLength));
  src.connect(node);
  return {
    stop() { src.disconnect(); node.disconnect(); void ctx.close(); conn.close(); },
  };
}
