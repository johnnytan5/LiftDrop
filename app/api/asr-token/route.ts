// Short-lived AssemblyAI streaming token, so the browser never sees the API key.
// ponytail: no per-caller limit; add one (MuseConcierge lib/limits.ts) before a public launch.
export async function GET() {
  if (!process.env.ASSEMBLYAI_API_KEY) return Response.json({ error: 'speech is offline (no AssemblyAI key)' }, { status: 503 });
  const res = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=600', {
    headers: { Authorization: process.env.ASSEMBLYAI_API_KEY },
  });
  if (!res.ok) return Response.json({ error: `AssemblyAI token failed (${res.status})` }, { status: 502 });
  const { token } = await res.json();
  return Response.json({ token });
}
