// Runs once when the backend boots: resume work that lived in timers of the previous process.
// Not awaited: register() gates the server's readiness, and this needs Supabase round trips.
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  void (async () => {
    const db = await import('./lib/db.ts');
    const orders = await import('./lib/orders.ts');
    await orders.syncPendingPayouts().catch((e) => console.error('boot payouts:', e));
    // Only recent ones: older orders were left by earlier demo runs, not by a robot still standing there.
    const recent = (o: { created_at: string }) => Date.now() - Date.parse(o.created_at) < 3_600_000;
    for (const o of (await db.listOrdersByStatus('at_door').catch(() => [])).filter(recent)) orders.watchDoor(o.id, 30_000);
  })();
}
