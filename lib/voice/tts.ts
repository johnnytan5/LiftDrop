// The order line's voice: AssemblyAI TTS streamed from app/api/tts. If that can't start, the
// browser's own voice takes over, so a call never goes silent. From MuseConcierge.
import type { Gate } from './gate.ts';

const START_AHEAD_S = 0.06; // a little runway so the first chunks don't underrun

let ctx: AudioContext | null = null;
let playing = new Set<AudioBufferSourceNode>();
let cut = 0; // bumped by hush(): a reply still streaming stops scheduling audio

/** Stop talking now (the caller approved mid-sentence). The interrupted reply resolves. */
export function hush() {
  cut++;
  for (const s of playing) { try { s.stop(); } catch { /* not started yet */ } }
  playing = new Set();
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

function browserVoice(text: string, gate: Gate): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.05;
    const done = () => { gate.end(); resolve(); };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// Plays the streamed 16-bit mono PCM as it arrives. False if no audio came.
async function streamedVoice(text: string, gate: Gate): Promise<boolean> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) return false;
  const rate = Number(res.headers.get('X-Sample-Rate')) || 24000;
  ctx ??= new AudioContext();
  await ctx.resume();
  const audio = ctx;
  const reader = res.body.getReader();
  const mine = cut;
  let at = 0;
  let last: AudioBufferSourceNode | null = null;
  let spare: Uint8Array | null = null; // half a sample split across two chunks
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break; // cut off mid-reply: what already played stands
    }
    if (mine !== cut) { void reader.cancel(); break; }
    if (chunk.done) break;
    const bytes: Uint8Array = spare ? new Uint8Array([...spare, ...chunk.value]) : chunk.value;
    const even = bytes.length - (bytes.length % 2);
    spare = even < bytes.length ? bytes.slice(even) : null;
    if (!even) continue;
    const pcm = new DataView(bytes.buffer, bytes.byteOffset, even);
    const buffer = audio.createBuffer(1, even / 2, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    at = Math.max(at, audio.currentTime + START_AHEAD_S);
    source.start(at);
    playing.add(source);
    source.onended = () => playing.delete(source);
    at += buffer.duration;
    last = source;
  }
  if (mine !== cut) { gate.end(); return true; } // hushed: don't fall back to the browser voice
  if (!last) return false;
  const end = last;
  await new Promise<void>((resolve) => { end.onended = () => { playing.delete(end); resolve(); }; if (mine !== cut) resolve(); });
  gate.end();
  return true;
}

export async function speak(text: string, gate: Gate): Promise<void> {
  gate.start();
  let spoke = false;
  try {
    spoke = await streamedVoice(text, gate);
  } catch {
    // falls through to the browser's voice
  }
  if (!spoke) await browserVoice(text, gate);
}
