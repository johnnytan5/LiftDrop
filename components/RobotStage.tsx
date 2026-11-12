'use client';

// The live tower: MuJoCo physics in a worker, drawn with three.js, driving real orders.
// It claims a held order (first tab wins), runs the delivery, and forwards every sensor event
// to /api/events in order, so the money moves from what the sensors saw. The shop's "Loaded"
// and the customer's "I've taken my order" reach it through the database, so they can come
// from other devices.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TowerHandle, TowerStatus } from './TowerView.tsx';
import { CODE_WAIT_S, type Floor, type SimEvent, type Stop } from '../lib/sim/tower.ts';
import type { Compartment, Item, LedgerRow, Order, OrderItem, Shop } from '../lib/db.ts';
import RobotScreen, { type ScreenMode } from './RobotScreen.tsx';
import Nudge, { type NudgeTip } from './Nudge.tsx';
import type { CameraCheck } from '../lib/vision.ts';

const TowerView = dynamic(() => import('./TowerView.tsx'), { ssr: false });

type State = { shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[]; ledger: LedgerRow[]; order_items: OrderItem[] };
type Shot = { when: 'before' | 'after' | 'returned'; image: string; result?: CameraCheck; error?: string; shop?: string };
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

/** Lift height shown as the floor the lift is passing: G at 0 m, L20 at 3.2 m, L23 at 6.4 m (21-22 between). */
export const floorOf = (s: TowerStatus) => (s.lift <= 3.2 ? Math.round((s.lift / 3.2) * 20) : 20 + Math.round(((s.lift - 3.2) / 3.2) * 3));
/** Which office floor an order goes to, from its location ('L20-gate', 'L23-gate'). */
export const floorFor = (location: string): Floor => (location.startsWith('L20') ? 20 : 23);

export default function RobotStage({ onRobot }: { onRobot?: (s: TowerStatus) => void }) {
  const tower = useRef<TowerHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<TowerStatus | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [autoLoad, setAutoLoad] = useState(false); // off: staff load by hand, so the shop's side of the demo shows
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
  const slotWas = useRef({ A: false, B: false });
  const stopsRef = useRef<Stop[]>([]);
  const handLoad = useRef(false); // this trip waits for shop staff to tap Loaded on the robot
  const [liveCam, setLiveCam] = useState<{ comp: string; image: string } | null>(null);
  const [robotName, setRobotName] = useState('LiftDrop robot');

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

  // Fleet heartbeat for /ops: where this robot is and what it's doing, once a second.
  const live = useRef<{ status: TowerStatus | null; speed: number }>({ status: null, speed: 2 });
  useEffect(() => {
    const t = setInterval(() => {
      const st = live.current.status;
      if (!st) return;
      fetch('/api/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        session: me.current, phase: st.phase, floor: floorOf(st), x: st.x, y: st.y, grams: st.grams, doors: st.doors,
        order: activeRef.current, speed: live.current.speed,
      }) }).then((r) => r.json()).then((j) => { if (j.name) setRobotName(j.name); }).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Doors closed this round. When all are shut (or the door timed out) the backend has decided:
  // still at_door means the agent asked the customer to check, so the robot reopens and waits.
  const closed = useRef({ count: 0, of: 0 });
  const [codeUntil, setCodeUntil] = useState(0); // when the robot stops waiting for the gate code
  const onEvent = useCallback((e: SimEvent) => {
    const id = activeRef.current;
    if (!id) return;
    if (e.type === 'arrived') setCodeUntil(Date.now() + CODE_WAIT_S * 1000);
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
    for (const k of ['A', 'B'] as const) tower.current.dishes(k, dishesRef.current[k] ?? []);
    setShots({});
    raised.current.clear();
    closed.current = { count: 0, of: stops.length };
    stopsRef.current = stops;
    handLoad.current = !autoLoad;
    setActive(o.id);
    setLog([]);
    tower.current.deliver(stops, { autoLoad, doorTimeout: 90, awaitVerdict: true, floor: floorFor(o.location), codeWaitMs: CODE_WAIT_S * 1000 });
    note(`${o.id}: ${stops.map((s) => `${s.label} → ${s.comp}`).join(', ')}, to level ${floorFor(o.location)}`);
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
  const atDoor = !!status?.phase.startsWith('at the gate');
  const sum = (k: string) => state?.ledger.filter((l) => l.order_id === active && l.kind === k).reduce((s, l) => s + l.amount_cents, 0) ?? 0;
  const floor = status ? floorOf(status) : 0;

  // What the robot's own screen shows, from its phase and the order it carries.
  const phase = status?.phase ?? 'idle';
  // Leftovers handed back at a shop: once the robot leaves the counter, film that compartment
  // again so the panel shows it empty (a local frame; nothing for SAM to check).
  const prevPhase = useRef(phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = phase;
    const stop = was.startsWith('handing back at ') && phase !== was ? stopsRef.current.find((x) => was === `handing back at ${x.label}`) : undefined;
    const img = stop && tower.current?.photo(stop.comp as 'A' | 'B', dishesRef.current[stop.comp] ?? []);
    if (stop && img) setShots((s) => ({ ...s, [stop.comp]: { when: 'returned', image: img, shop: stop.label } }));
  }, [phase]);
  const loadingAt = active && handLoad.current ? stopsRef.current.find((x) => phase === `loading at ${x.label}`) : undefined;
  const itemName = (id: string) => state?.items.find((i) => i.id === id)?.name ?? id;
  const returningAt = active && handLoad.current ? stopsRef.current.find((x) => phase === `handing back at ${x.label}`) : undefined;
  const itemsIn = (comp: string) => (state?.order_items ?? []).filter((l) => l.order_id === active && l.compartment_id === comp).map((l) => `${l.qty}× ${itemName(l.item_id)}`);
  const dest = order ? floorFor(order.location) : floor;
  const collecting = /^(to |loading at )/.test(phase) && !/lift|gate/.test(phase);
  const screen: ScreenMode = !ready ? { kind: 'status', title: 'Starting up', text: 'Loading the robot…' }
    : loadingAt ? {
      kind: 'load', shop: loadingAt.label, comp: loadingAt.comp,
      items: itemsIn(loadingAt.comp),
      done: !!comps.find((c) => c.id === loadingAt.comp)?.vendor_loaded_at,
    }
    : returningAt ? { kind: 'return', shop: returningAt.label, comp: returningAt.comp, items: itemsIn(returningAt.comp) }
    : active && phase === 'calling customer' ? { kind: 'code', floor, until: codeUntil }
    : active && atDoor && phase === 'at the gate' ? { kind: 'open', comps: comps.map((c) => c.id) }
    : phase === 'idle' ? { kind: 'status', title: 'Ready', text: 'Docked and charging. Waiting for an order.' }
    : { kind: 'status', title: /return|dock|handing back/.test(phase) ? 'Heading back' : !active ? 'Busy' : collecting ? 'Collecting an order' : `Delivering to Level ${dest}`, text: `${phase[0].toUpperCase()}${phase.slice(1)}. Compartments locked.` };
  const loadComp = loadingAt?.comp ?? returningAt?.comp;
  // What the demo is waiting on a person for; Nudge points at it if nobody acts for a while.
  const bagOut = comps.some((c) => status && !status.inSlot[c.id as 'A' | 'B']);
  const tip: NudgeTip | null = screen.kind === 'load' && !screen.done
    ? { key: `load:${active}:${screen.comp}`, el: '.rs-glass .rs-big', say: `You're the ${screen.shop} staff now: put the bag in compartment ${screen.comp}, then tap “Loaded” on the robot's screen.` }
    : screen.kind === 'return'
    ? { key: `return:${active}:${screen.comp}`, el: '.rs-glass .rs-big', say: `The robot brought back what wasn't collected. As the ${screen.shop} staff, take it out of compartment ${screen.comp}, then tap “Taken back”.` }
    : screen.kind === 'code'
    ? { key: `code:${active}`, el: '.rs-code', say: 'The robot is at your security gate. Type the 4-digit code shown on the phone into its screen.' }
    : screen.kind === 'open' && !bagOut
    ? { key: `take:${active}`, el: '.mimic', say: 'Play the customer: take out the bags you want. A bag you leave goes back to the shop and isn’t charged, unless the shop marked it final sale.' }
    : screen.kind === 'open'
    ? { key: `done:${active}`, el: '.rs-glass .rs-big', say: 'Got what you wanted? Tap “I’ve taken my order”: the doors close and PayPal settles.' }
    : null;
  // Inside camera, live, while staff load this compartment by hand (rendered here, not sent to SAM).
  // After the robot moves on it keeps filming that compartment a moment, so staff see the bag inside.
  const lastLoad = useRef<string | null>(null);
  useEffect(() => {
    const comp = loadComp ?? lastLoad.current;
    if (!comp) return;
    lastLoad.current = loadComp ?? null;
    const shoot = () => { const img = tower.current?.photo(comp as 'A' | 'B', dishesRef.current[comp] ?? []); if (img) setLiveCam({ comp, image: img }); };
    shoot();
    const t = setInterval(shoot, 400);
    const off = loadComp ? 0 : window.setTimeout(() => { clearInterval(t); setLiveCam(null); }, 2500);
    return () => { clearInterval(t); clearTimeout(off); };
  }, [loadComp]);

  return (
    <div className="stage">
      <RobotScreen
        name={robotName} mode={screen}
        onLoaded={(c) => { if (active) post(`/api/orders/${active}`, { action: 'loaded', compartment: c }).then(() => { note(`staff tapped Loaded on the robot: ${c}`); refresh(); }).catch((e) => note(e.message, false)); }}
        onReturned={(c) => { tower.current?.raise(`returned:${c}`); note(`shop staff took back compartment ${c}`); }}
        onCode={async (code) => {
          const r = await post(`/api/orders/${active}`, { action: 'unlock', code });
          note(r.unlocked ? 'right code: compartments unlocked' : `wrong code (${r.tries_left} tries left)`, r.unlocked);
          if (r.unlocked) tower.current?.raise('unlock');
          return r;
        }}
        onDone={() => { if (active) post(`/api/orders/${active}`, { action: 'done' }).then(refresh).catch((e) => note(e.message, false)); }}
      />
      {liveCam && (
        <figure className="livecam" aria-label={`Compartment ${liveCam.comp} inside camera, live`}>
          <img src={liveCam.image} alt="" />
          <figcaption><span className="rec" aria-hidden="true" />LIVE · compartment {liveCam.comp} camera</figcaption>
        </figure>
      )}
      <TowerView
        onReady={(h) => { tower.current = h; h.speed(speed); setReady(true); }}
        onStatus={(s) => {
          // A bag left its compartment at the gate: re-shoot that camera now, so the panel shows what
          // the tower view shows instead of the photo from when the doors opened.
          for (const k of ['A', 'B'] as const) {
            if (slotWas.current[k] && !s.inSlot[k] && activeRef.current && s.phase.startsWith('at the gate')) void photo(k, 'after');
            slotWas.current[k] = s.inSlot[k];
          }
          live.current.status = s; setStatus(s); onRobot?.(s);
        }}
        onEvent={onEvent}
        onDone={(r) => { note(`robot docked${r.leftovers.length ? `; returned ${r.leftovers.join(', ')} to the shop` : ''}`); activeRef.current = null; }}
        onError={(m) => note(m, false)}
      />

      <Nudge tip={tip} />
      <div className="stage-top">
        <div className="lift-panel" aria-live="polite">
          <span className="led small-led"><span className="led-arrow">{status?.phase.includes('↑') ? '▲' : ''}</span><span className="led-num">{floor === 0 ? 'G' : floor}</span></span>
          <span className="phase">{!ready ? 'Starting MuJoCo…' : status?.phase === 'idle' ? 'Docked, waiting for an order' : status?.phase}</span>
        </div>
        <div className="stage-ctrl">
          <span className="ctrl-label">Speed</span>
          {[1, 2, 4].map((x) => (
            <button key={x} aria-pressed={speed === x} onClick={() => { setSpeed(x); live.current.speed = x; tower.current?.speed(x); }}>{x}×</button>
          ))}
          <label title="Off: the robot waits at each counter until shop staff tap Loaded on its screen">
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
                  <img src={sh.image} alt={`Compartment ${k} camera, ${sh.when === 'before' ? 'doors opening' : sh.when === 'returned' ? `after handing back at ${sh.shop}` : 'doors closing'}`} />
                  {sh.result && Object.entries(sh.result.found).map(([slot, b]) => b && (
                    <span key={slot} className="cam-box" style={{ left: `${(b.x1 / b.w) * 100}%`, top: `${(b.y1 / b.h) * 100}%`, width: `${((b.x2 - b.x1) / b.w) * 100}%`, height: `${((b.y2 - b.y1) / b.h) * 100}%` }} />
                  ))}
                </div>
                <figcaption>
                  <span className="comp-tag">{k}</span>
                  {sh.when === 'returned' ? `empty · back at ${sh.shop}` : sh.error ? 'camera check failed' : !sh.result ? 'checking…'
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
            <div><span>Held</span><b>{$(sum('held'))}</b></div>
            <div><span>Charged</span><b>{$(sum('captured'))}</b></div>
            <div><span>Released</span><b>{$(sum('voided'))}</b></div>
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
