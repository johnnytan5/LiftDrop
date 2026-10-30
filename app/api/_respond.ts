// Shared JSON wrapper: thrown errors become 400s with the message.
export async function respond(fn: () => Promise<unknown>) {
  try {
    return Response.json(await fn());
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
