'use client';

// The live tower: MuJoCo physics in a worker, drawn with three.js, driving real orders.
// It claims a held order (first tab wins), runs the delivery, and forwards every sensor event
// to /api/events in order, so the money moves from what the sensors saw. The shop's "Loaded"
// and the customer's "I've taken my order" reach it through the database, so they can come
// from other devices.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TowerHandle, TowerStatus } from './TowerView.tsx';
import type { SimEvent, Stop } from '../lib/sim/tower.ts';
import type { Compartment, LedgerRow, Order, OrderItem, Shop } from '../lib/db.ts';
import type { CameraCheck } from '../lib/vision.ts';

const TowerView = dynamic(() => import('./TowerView.tsx'), { ssr: false });

type State = { shops: Shop[]; orders: Order[]; compartments: Compartment[]; ledger: LedgerRow[]; order_items: OrderItem[] };
type Shot = { when: 'before' | 'after'; image: string; result?: CameraCheck; error?: string };
type Log = { at: string; text: string; ok: boolean };

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const FRESH_MS = 15 * 60_000; // only pick up recent orders, not leftovers from an old session

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
}

function session() {
  try {
    let s = sessionStorage.getItem('liftdrop-robot');
    if (!s) sessionStorage.setItem('liftdrop-robot', (s = crypto.randomUUID()));
    return s;
  } catch { return crypto.randomUUID(); }
}

/** Lift height (0..3.2 m in the model) shown as the floor the lift is passing. */
export const floorOf = (s: TowerStatus) => (s.floor === 23 && s.lift > 3.15 ? 23 : Math.round((s.lift / 3.2) * 23));

export default function RobotStage({ onRobot }: { onRobot?: (s: TowerStatus) => void }) {
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
  const raised = useRef(new Set<string>());
  const claiming = useRef(false);
  const me = useRef('');
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const dishesRef = useRef<Record<string, string[]>>({});
  const vision = useRef<Record<string, Promise<unknown>>>({});

  // Compartment camera: photograph now, ask SAM 3.1 (via /api/vision), keep the frame for the panel.
  // 'after' runs before door_closed is sent (see onEvent), so the handoff has the camera's verdict.
  const photo = useCallback((comp: 'A' | 'B', when: 'before' | 'after') => {
    const id = activeRef.current;
    if (!id || !tower.current) return Promise.resolve();
    const image = tower.current.photo(comp, dishesRef.current[comp] ?? []);
    setShots((s) => ({ ...s, [comp]: { when, image } }));
    const job = post('/api/vision', { order_id: id, compartment: comp, when, image })
      .then((result: CameraCheck) => {
        setShots((s) => (s[comp]?.image === image ? { ...s, [comp]: { when, image, result } } : s));
        const v = Object.values(result.found);
        note(`camera ${comp} ${when}: SAM 3.1 sees ${v.filter(Boolean).length} of ${v.length}${result.failed.length ? `, ${result.failed.length} unchecked` : ''} (${result.ms} ms)`);
      })
      .catch((e) => { setShots((s) => ({ ...s, [comp]: { when, image, error: (e as Error).message } })); note(`camera ${comp}: ${(e as Error).message}`, false); });
    vision.current[comp] = job;
    return job;
  }, []);

  const note = (text: string, ok = true) => setLog((l) => [{ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text, ok }, ...l].slice(0, 30));

  const refresh = useCallback(() => fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()).then(setState).catch(() => {}), []);
  useEffect(() => { me.current = session(); refresh(); const t = setInterval(refresh, 1000); return () => clearInterval(t); }, [refresh]);

  // Doors closed this round. When all are shut (or the door timed out) the backend has decided:
  // still at_door means the agent asked the customer to check, so the robot reopens and waits.
  const closed = useRef({ count: 0, of: 0 });
  const onEvent = useCallback((e: SimEvent) => {
    const id = activeRef.current;
    if (!id) return;
    if (e.type === 'snapshot') return void photo(e.compartment, 'after'); // photographed now, checked in parallel
    const label = 'compartment' in e ? `${e.type} ${e.compartment}${'grams' in e ? ` · ${e.grams} g` : ''}` : e.type;
    if (e.type === 'door_opened') closed.current.count = 0;
    queue.current = queue.current.then(async () => {
      // The handoff runs on these; it needs the cameras' verdict.
      if (e.type === 'door_closed') await vision.current[e.compartment];
      if (e.type === 'timeout') await Promise.all(Object.values(vision.current));
      let status: string | null = null;
      try {
        status = (await post('/api/events', { order_id: id, ...e })).status;
        note(`${label} → ${status}`);
        if (e.type === 'door_opened') void photo(e.compartment, 'before');
      } catch (err) {
        note(`${label} → ${(err as Error).message}`, false);
      }
      const roundOver = e.type === 'timeout' || (e.type === 'door_closed' && ++closed.current.count === closed.current.of);
      if (roundOver) tower.current?.raise(status === 'at_door' ? 'reopen' : 'settled');
      refresh();
    });
  }, [refresh, photo]);

  const start = useCallback((o: Order, comps: Compartment[], shops: Shop[], items: OrderItem[]) => {
    if (!tower.current) return;
    const stops: Stop[] = comps.map((c) => ({
      comp: c.id as 'A' | 'B', shop: c.shop_id as Stop['shop'], grams: c.expected_g,
      label: shops.find((s) => s.id === c.shop_id)?.name ?? c.shop_id,
    }));
    activeRef.current = o.id;
    // One entry per unit: what each compartment camera should find.
    dishesRef.current = Object.fromEntries(comps.map((c) => [c.id, items.filter((l) => l.compartment_id === c.id).flatMap((l) => Array(l.qty).fill(l.item_id))]));
    vision.current = {};
    setShots({});
    raised.current.clear();
    closed.current = { count: 0, of: stops.length };
    setActive(o.id);
    setLog([]);
    tower.current.deliver(stops, { autoLoad, doorTimeout: 90, awaitVerdict: true });
    note(`${o.id}: ${stops.map((s) => `${s.label} → ${s.comp}`).join(', ')}`);
  }, [autoLoad]);

  // Pick up the next held order nobody is driving, and pass on signals from the phone and the shop.
  useEffect(() => {
    if (!state || !ready) return;
    const id = activeRef.current;
    if (!id && !claiming.current) {
      const next = state.orders.filter((o) => o.status === 'held' && !o.robot_session && Date.now() - Date.parse(o.created_at) < FRESH_MS).at(-1);
      if (next) {
        claiming.current = true;
        post(`/api/orders/${next.id}`, { action: 'claim', session: me.current })
          .then(() => start(next, state.compartments.filter((c) => c.order_id === next.id), state.shops, state.order_items.filter((l) => l.order_id === next.id)))
          .catch(() => {}) // another tab got it first
          .finally(() => { claiming.current = false; });
      }
      return;
    }
    if (!id) return;
    const once = (key: string, name = key) => { if (raised.current.has(key)) return; raised.current.add(key); tower.current?.raise(name); };
    for (const c of state.compartments.filter((x) => x.order_id === id && x.vendor_loaded_at)) once(`loaded:${c.id}`);
    const done = state.orders.find((o) => o.id === id)?.customer_done_at;
    if (done) once(`done:${done}`, 'done'); // one per tap: a second tap after the agent's question closes the doors again
  }, [state, ready, start]);

  const order = state?.orders.find((o) => o.id === active);
  const comps = state?.compartments.filter((c) => c.order_id === active) ?? [];
  const atDoor = !!status?.phase.startsWith('at door');
  const sum = (k: string) => state?.ledger.filter((l) => l.order_id === active && l.kind === k).reduce((s, l) => s + l.amount_cents, 0) ?? 0;
  const floor = status ? floorOf(status) : 0;

  return (
    <div className="stage">
      <TowerView
        onReady={(h) => { tower.current = h; h.speed(speed); setReady(true); }}
        onStatus={(s) => { setStatus(s); onRobot?.(s); }}
        onEvent={onEvent}
        onDone={(r) => { note(`robot docked${r.leftovers.length ? `; returned ${r.leftovers.join(', ')} to the shop` : ''}`); activeRef.current = null; }}
        onError={(m) => note(m, false)}
      />

      <div className="stage-top">
        <div className="lift-panel" aria-live="polite">
          <span className="led small-led"><span className="led-arrow">{status?.phase.includes('lift') ? (status.floor === 23 ? '▼' : '▲') : ''}</span><span className="led-num">{floor === 0 ? 'G' : floor}</span></span>
          <span className="phase">{!ready ? 'Starting MuJoCo…' : status?.phase === 'idle' ? 'Docked, waiting for an order' : status?.phase}</span>
        </div>
        <div className="stage-ctrl">
          <span className="ctrl-label">Speed</span>
          {[1, 2, 4].map((x) => (
            <button key={x} aria-pressed={speed === x} onClick={() => { setSpeed(x); tower.current?.speed(x); }}>{x}×</button>
          ))}
          <label title="Off: the robot waits at each counter until the shop taps Loaded on /vendor">
            <input type="checkbox" checked={autoLoad} onChange={(e) => setAutoLoad(e.target.checked)} /> Shops load instantly
          </label>
        </div>
      </div>

      {atDoor && active && (
        <div className="mimic" role="group" aria-label="Stand in for the customer">
          <span>Customer’s hands</span>
          {comps.map((c) => (
            <button key={c.id} onClick={() => tower.current?.take(c.id as 'A' | 'B')}>Take bag {c.id}</button>
          ))}
          {comps.map((c) => (
            <button key={`f${c.id}`} className="ghost" title="Weight drop doesn't match the item: the agent decides" onClick={() => tower.current?.take(c.id as 'A' | 'B', 0.5)}>Half-take {c.id}</button>
          ))}
        </div>
      )}

      {active && Object.keys(shots).length > 0 && (
        <div className="cams" aria-label="Compartment cameras, checked by SAM 3.1">
          <div className="cams-head">Compartment cameras · SAM 3.1</div>
          {(['A', 'B'] as const).filter((k) => shots[k]).map((k) => {
            const sh = shots[k]!;
            const found = sh.result ? Object.values(sh.result.found) : [];
            const seen = found.filter(Boolean).length;
            return (
              <figure key={k} className="cam">
                <div className="cam-frame">
                  <img src={sh.image} alt={`Compartment ${k} camera, ${sh.when === 'before' ? 'doors opening' : 'doors closing'}`} />
                  {sh.result && Object.entries(sh.result.found).map(([slot, b]) => b && (
                    <span key={slot} className="cam-box" style={{ left: `${(b.x1 / b.w) * 100}%`, top: `${(b.y1 / b.h) * 100}%`, width: `${((b.x2 - b.x1) / b.w) * 100}%`, height: `${((b.y2 - b.y1) / b.h) * 100}%` }} />
                  ))}
                </div>
                <figcaption>
                  <span className="comp-tag">{k}</span>
                  {sh.error ? 'camera check failed' : !sh.result ? 'checking…'
                    : sh.when === 'before' ? `sees ${seen} of ${found.length}`
                    : seen === 0 ? 'empty: taken' : seen === found.length ? 'still there' : `${found.length - seen} of ${found.length} taken`}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      <div className="stage-bottom">
        <div className="sensors">
          {(['A', 'B'] as const).map((k) => (
            <div key={k} className="sensor">
              <span className="comp-tag">{k}</span>
              <span>{status ? `${status.grams[k]} g` : '–'}</span>
              <span className={status && status.doors[k] > 0.25 ? 'door open' : 'door'}>{status && status.doors[k] > 0.25 ? 'open' : 'closed'}</span>
            </div>
          ))}
        </div>
        <div className="money" aria-label="Money for this order">
          {order ? <>
            {order.payment_mode === 'charge' ? <>
              <div><span>Paid now</span><b>{$(sum('captured'))}</b></div>
              <div><span>Refunded</span><b>{$(sum('refunded'))}</b></div>
            </> : <>
              <div><span>Held</span><b>{$(sum('held'))}</b></div>
              <div><span>Charged</span><b>{$(sum('captured'))}</b></div>
              <div><span>Released</span><b>{$(sum('voided'))}</b></div>
            </>}
            <div><span>Shops paid</span><b>{$(sum('paid_out'))}{sum('payout_pending') > sum('paid_out') ? ' …' : ''}</b></div>
          </> : <span className="quiet">Money for the current order shows here.</span>}
        </div>
        <ol className="events" aria-label="Sensor events sent to the backend">
          {log.length === 0 ? <li className="quiet">Sensor events appear here.</li>
            : log.map((l, i) => <li key={i} className={l.ok ? '' : 'bad'}><time>{l.at}</time> {l.text}</li>)}
        </ol>
      </div>
    </div>
  );
}
