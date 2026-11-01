'use client';

// Operator's robot view: the MuJoCo tower plus mission controls. A held order becomes a
// delivery; every sensor event the robot emits is forwarded to /api/events in order, so the
// money moves from what the sensors saw, not from these buttons.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TowerHandle, TowerStatus } from '../../components/TowerView.tsx';
import type { SimEvent, Stop } from '../../lib/sim/tower.ts';
import type { Compartment, LedgerRow, Order, Shop } from '../../lib/db.ts';

const TowerView = dynamic(() => import('../../components/TowerView.tsx'), { ssr: false });

type State = { shops: Shop[]; orders: Order[]; compartments: Compartment[]; ledger: LedgerRow[] };
type Log = { at: string; text: string; ok: boolean };

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const btn: React.CSSProperties = { padding: '7px 11px', border: '1px solid #3a4352', borderRadius: 7, background: '#1c232e', color: '#e8ecf2', cursor: 'pointer', fontSize: 13 };
const panel: React.CSSProperties = { background: '#161c25', border: '1px solid #273040', borderRadius: 10, padding: 14 };

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
}

export default function SimPage() {
  const tower = useRef<TowerHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<TowerStatus | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [autoLoad, setAutoLoad] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [log, setLog] = useState<Log[]>([]);
  const queue = useRef(Promise.resolve());
  const activeRef = useRef<string | null>(null);

  const refresh = useCallback(() => fetch('/api/state').then((r) => r.json()).then(setState).catch(() => {}), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 1000); return () => clearInterval(t); }, [refresh]);

  const note = (text: string, ok = true) => setLog((l) => [{ at: new Date().toLocaleTimeString(), text, ok }, ...l].slice(0, 40));

  // Sensor events go to the backend strictly in order.
  const onEvent = useCallback((e: SimEvent) => {
    const id = activeRef.current;
    if (!id) return;
    const label = 'compartment' in e ? `${e.type} ${e.compartment}${'grams' in e ? ` ${e.grams} g` : ''}` : e.type;
    queue.current = queue.current.then(async () => {
      try {
        const o = await post('/api/events', { order_id: id, ...e });
        note(`${label} → ${o.status}`);
      } catch (err) {
        note(`${label} → ${(err as Error).message}`, false);
      }
      refresh();
    });
  }, [refresh]);

  const start = (o: Order) => {
    if (!state || !tower.current) return;
    const stops: Stop[] = state.compartments.filter((c) => c.order_id === o.id).map((c) => ({
      comp: c.id as 'A' | 'B', shop: c.shop_id as Stop['shop'], grams: c.expected_g,
      label: state.shops.find((s) => s.id === c.shop_id)?.name ?? c.shop_id,
    }));
    activeRef.current = o.id;
    setActive(o.id);
    setLog([]);
    tower.current.speed(speed);
    tower.current.deliver(stops, { autoLoad, doorTimeout: 60 });
    note(`delivering ${o.id}: ${stops.map((s) => `${s.label} → ${s.comp}`).join(', ')}`);
  };

  const demoOrder = async () => {
    try {
      const o = await post('/api/orders', { location: 'L23-pantry', cart: [{ item_id: 'croissant', qty: 1 }, { item_id: 'iced-latte', qty: 1 }] });
      await post('/api/authorize', { order_id: o.id });
      note(`${o.id} created and held (${$(o.total_cents)})`);
      refresh();
    } catch (err) { note((err as Error).message, false); }
  };

  const order = state?.orders.find((o) => o.id === active);
  const comps = state?.compartments.filter((c) => c.order_id === active) ?? [];
  const held = state?.orders.filter((o) => o.status === 'held') ?? [];
  const atDoor = status?.phase === 'at door';
  const loadingAt = status?.phase.startsWith('loading at') ? status.phase : null;
  const sum = (k: string) => state?.ledger.filter((l) => l.order_id === active && l.kind === k).reduce((s, l) => s + l.amount_cents, 0) ?? 0;

  return (
    <main style={{ minHeight: '100vh', background: '#0c1016', color: '#e8ecf2', fontFamily: 'system-ui, sans-serif', display: 'flex', flexWrap: 'wrap' }}>
      <section style={{ flex: '1 1 640px', height: '100vh', minHeight: 420, position: 'relative' }}>
        <TowerView
          onReady={(h) => { tower.current = h; h.speed(speed); setReady(true); }}
          onStatus={setStatus}
          onEvent={onEvent}
          onDone={(r) => { note(`robot docked${r.leftovers.length ? `, returned ${r.leftovers.join(', ')} to the shop` : ''}`); activeRef.current = null; }}
          onError={(m) => note(m, false)}
        />
        {status && (
          <div style={{ position: 'absolute', left: 12, top: 12, ...panel, padding: '8px 12px', fontSize: 13 }}>
            <strong>{status.phase}</strong> · {status.floor === 23 ? 'Level 23' : 'Lobby'} · lift {status.lift.toFixed(1)} m
          </div>
        )}
      </section>

      <aside style={{ flex: '0 1 380px', padding: 16, display: 'grid', gap: 12, alignContent: 'start', maxHeight: '100vh', overflowY: 'auto' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>LiftDrop · robot</h1>

        <div style={panel}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={btn} onClick={demoOrder}>New demo order</button>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={autoLoad} onChange={(e) => setAutoLoad(e.target.checked)} /> auto-load at counters</label>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            Speed {[1, 2, 4].map((x) => (
              <button key={x} style={{ ...btn, padding: '4px 9px', background: speed === x ? '#2b5ea8' : btn.background }}
                onClick={() => { setSpeed(x); tower.current?.speed(x); }}>{x}×</button>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {held.length === 0 ? <span style={{ color: '#8b95a5' }}>No held orders. Create one, or pay on the order page.</span>
              : held.map((o) => (
                <button key={o.id} disabled={!ready || !!activeRef.current} style={{ ...btn, marginRight: 6, marginBottom: 6 }} onClick={() => start(o)}>
                  Deliver {o.id} · {$(o.total_cents)}
                </button>
              ))}
          </div>
        </div>

        {loadingAt && !autoLoad && (
          <div style={panel}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Shop staff, {loadingAt.replace('loading at ', '')}:</div>
            {comps.map((c) => <button key={c.id} style={{ ...btn, marginRight: 6 }} onClick={() => tower.current?.raise(`loaded:${c.id}`)}>Loaded {c.id}</button>)}
          </div>
        )}

        {atDoor && (
          <div style={panel}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Customer at the pantry:</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {comps.map((c) => (
                <span key={c.id} style={{ display: 'contents' }}>
                  <button style={btn} onClick={() => tower.current?.take(c.id as 'A' | 'B')}>Take {c.id} ({c.shop_id})</button>
                  <button style={btn} title="Weight drop doesn't match the item" onClick={() => tower.current?.take(c.id as 'A' | 'B', 0.5)}>Fault: half {c.id}</button>
                </span>
              ))}
              <button style={{ ...btn, background: '#2b5ea8' }} onClick={() => tower.current?.raise('done')}>Customer done</button>
            </div>
            <div style={{ fontSize: 12, color: '#8b95a5', marginTop: 8 }}>Not pressing “done” times out after 60 s (sim time).</div>
          </div>
        )}

        {status && (
          <div style={{ ...panel, fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '4px 12px' }}>
            <span /> <strong>A</strong> <strong>B</strong>
            <span>Scale</span> <span>{status.grams.A} g</span> <span>{status.grams.B} g</span>
            <span>Door</span> <span>{status.doors.A > 0.25 ? 'open' : 'closed'}</span> <span>{status.doors.B > 0.25 ? 'open' : 'closed'}</span>
          </div>
        )}

        {order && (
          <div style={{ ...panel, fontSize: 13 }}>
            <div><strong>{order.id}</strong> · <code>{order.status}</code></div>
            {order.customer_message && <div style={{ marginTop: 6 }}>Customer sees: “{order.customer_message}”</div>}
            <div style={{ marginTop: 6, color: '#b8c2d0' }}>
              held {$(sum('held'))} · charged {$(sum('captured'))} · released {$(sum('voided'))} · shops pending {$(sum('payout_pending') - sum('paid_out'))} · paid {$(sum('paid_out'))}
            </div>
          </div>
        )}

        <div style={{ ...panel, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace' }}>
          <div style={{ marginBottom: 6, color: '#8b95a5' }}>Sensor events → /api/events</div>
          {log.length === 0 ? <div style={{ color: '#5d6878' }}>—</div> : log.map((l, i) => (
            <div key={i} style={{ color: l.ok ? '#c9d3e0' : '#ff8a8a' }}>{l.at} {l.text}</div>
          ))}
        </div>
      </aside>
    </main>
  );
}
