// The order line's voice: AssemblyAI text-to-speech, streamed through here so the key stays
// on the server. From MuseConcierge app/api/tts. Change the voice with TTS_VOICE.
const URL = 'https://tts.us.assemblyai.com/v1/speech';
const MAX_CHARS = 600; // a spoken reply is a sentence or two; this caps spend
const FIRST_AUDIO_TIMEOUT_MS = 5000; // past this the page falls back to the browser voice

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text?: unknown };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHARS) return Response.json({ error: 'bad request' }, { status: 400 });
  if (!process.env.ASSEMBLYAI_API_KEY) return Response.json({ error: 'no voice' }, { status: 503 });
  const voice = process.env.TTS_VOICE ?? 'aai-sara';
  // Times out only the wait for the first byte: AbortSignal.timeout would also cut the audio
  // stream mid-sentence once a long reply takes more than 5 s to generate.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FIRST_AUDIO_TIMEOUT_MS);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: process.env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice }),
      signal: abort.signal,
    });
    clearTimeout(timer);
    if (!res.ok || !res.body) return Response.json({ error: `tts ${res.status}` }, { status: 502 });
    return new Response(res.body, { headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': res.headers.get('x-tts-sample-rate') ?? '24000' } });
  } catch (e) {
    clearTimeout(timer);
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 120) : 'tts failed' }, { status: 502 });
  }
}
