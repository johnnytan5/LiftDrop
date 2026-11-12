'use client';

// Operations console: the live fleet, what needs a person (escalations), and every recent order.
// Money actions go through /api/ops, which needs OPS_TOKEN only when one is set; each one is logged.

import { useCallback, useEffect, useState } from 'react';
import type { Compartment, Event, LedgerRow, Order, Shop } from '../../lib/db.ts';
import type { Robot } from '../../lib/fleet.ts';
import type { Escalation } from '../../lib/ops.ts';
import { Logo } from '../../components/Brand.tsx';

type Ops = { robots: Robot[]; escalations: Escalation[]; orders: Order[]; compartments: Compartment[]; ledger: LedgerRow[]; shops: Shop[]; ops: Event[] };

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const ago = (iso: string | number, now: number) => {
  const s = Math.max(0, Math.round((now - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
const TOKEN = 'liftdrop-ops-token';
const tok = { get: () => { try { return sessionStorage.getItem(TOKEN) ?? ''; } catch { return ''; } }, set: (v: string) => { try { sessionStorage.setItem(TOKEN, v); } catch { /* private mode */ } } };
const STATUS: Record<string, string> = {
  created: 'Checkout open', held: 'Waiting for robot', collecting: 'Collecting', en_route: 'In the lift', at_door: 'At the gate',
  captured: 'Charged', partially_captured: 'Part charged', paying_out: 'Paying shops', paid_out: 'Done', voided: 'Released', returning: 'Returning', failed: 'Failed',
};
const tone = (st: string) => (st === 'failed' ? 'bad' : ['held', 'collecting', 'en_route', 'at_door'].includes(st) ? 'live' : st === 'voided' ? 'muted' : 'ok');

/** The tower side-on: G, L20, L23 as strips, the robot as a dot at its x position on its floor. */
function TowerMap({ r }: { r: Robot }) {
  const rows = [23, 20, 0];
  const px = (x: number) => 8 + ((x + 7) / 14) * 184;
  return (
    <svg className="op-map" viewBox="0 0 200 74" role="img" aria-label={`${r.name} on ${r.floor === 0 ? 'the ground floor' : `level ${r.floor}`}`}>
      {rows.map((f, i) => (
        <g key={f}>
          <line x1={f === 0 ? 8 : px(1)} x2={192} y1={16 + i * 22} y2={16 + i * 22} className="op-map-slab" />
          <text x={2} y={13 + i * 22} className="op-map-label">{f === 0 ? 'G' : f}</text>
        </g>
      ))}
      <rect x={px(3.75)} y={2} width={px(5.25) - px(3.75)} height={62} className="op-map-shaft" />
      {(() => {
        const row = rows.indexOf(r.floor === 23 ? 23 : r.floor >= 20 ? 20 : 0);
        const inLift = /lift/.test(r.phase);
        const y = inLift ? 16 + ((23 - Math.min(23, r.floor)) / 23) * 44 : 16 + row * 22;
        return <circle cx={inLift ? px(4.5) : px(r.x)} cy={y - 5} r={4.5} className={`op-map-bot${r.online ? '' : ' off'}`} />;
      })()}
    </svg>
  );
}

function Confirm({ label, danger, onGo }: { label: string; danger?: boolean; onGo: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  return (
    <button className={`op-btn${danger ? ' danger' : ''}${armed ? ' armed' : ''}`} disabled={busy}
      onClick={async () => { if (!armed) return setArmed(true); setBusy(true); try { await onGo(); } finally { setBusy(false); setArmed(false); } }}>
      {busy ? 'Working…' : armed ? `Confirm: ${label}` : label}
    </button>
  );
}

export default function OpsPage() {
  const [d, setD] = useState<Ops | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [token, setToken] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(() => fetch('/api/ops', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (!j.error) setD(j); }).catch(() => {}), []);
  useEffect(() => { setToken(tok.get()); load(); const t = setInterval(() => { load(); setNow(Date.now()); }, 1000); return () => clearInterval(t); }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    const res = await fetch('/api/ops', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ops-token': token }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { setNeedToken(true); setMsg({ ok: false, text: 'Enter the operator token to take actions.' }); return; }
    setMsg(res.ok ? { ok: true, text: done } : { ok: false, text: j.error ?? `Failed (${res.status})` });
    load();
  };

  if (!d) return <main className="ops"><p className="op-empty">Loading operations…</p></main>;
  const name = (sess: string | null) => d.robots.find((r) => r.session === sess)?.name ?? (sess ? 'earlier session' : '—');
  const online = d.robots.filter((r) => r.online);
  const live = d.orders.filter((o) => ['held', 'collecting', 'en_route', 'at_door'].includes(o.status));
  const urgent = d.escalations.filter((e) => e.severity === 'urgent').length;
  const charged = d.orders.reduce((s, o) => s + o.captured_cents, 0);
  const comps = (id: string) => d.compartments.filter((c) => c.order_id === id);

  return (
    <main className="ops">
      <header className="op-head">
        <div className="op-brand"><Logo size={28} /><div><b>LiftDrop Ops</b><span>Halden Tower · G, L20, L23</span></div></div>
        <div className="op-kpis">
          <div><b>{online.length}<small>/{d.robots.length}</small></b><span>Robots online</span></div>
          <div><b>{live.length}</b><span>Live deliveries</span></div>
          <div className={urgent ? 'hot' : ''}><b>{d.escalations.length}</b><span>{urgent ? `${urgent} urgent` : 'Escalations'}</span></div>
          <div><b>{$(charged)}</b><span>Charged, last 20 orders</span></div>
        </div>
      </header>

      {msg && <p className={`op-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p>}
      {needToken && (
        <form className="op-token" onSubmit={(e) => { e.preventDefault(); tok.set(token); setNeedToken(false); setMsg({ ok: true, text: 'Token saved for this tab. Try the action again.' }); }}>
          <label>Operator token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
          <button className="op-btn">Save</button>
        </form>
      )}

      <section className="op-sec">
        <h2>Fleet</h2>
        {d.robots.length === 0 ? <p className="op-empty">No robot has reported yet. Open the demo page: each open stage tab is one robot.</p> : (
          <div className="op-fleet">
            {d.robots.map((r) => {
              const o = d.orders.find((x) => x.id === r.order);
              return (
                <article key={r.session} className={`op-robot${r.online ? '' : ' off'}`}>
                  <div className="op-robot-top">
                    <b>{r.name}</b>
                    <span className={`op-dot ${r.online ? 'on' : 'off'}`}>{r.online ? 'Online' : `Offline · ${ago(r.last, now)}`}</span>
                    <span className="led small-led"><span className="led-num">{r.floor === 0 ? 'G' : r.floor}</span></span>
                  </div>
                  <p className="op-phase">{r.phase === 'idle' ? 'Docked, idle' : r.phase}</p>
                  <TowerMap r={r} />
                  <dl className="op-robot-facts">
                    {(['A', 'B'] as const).map((c) => <div key={c}><dt>Bay {c}</dt><dd>{r.grams[c]} g · {r.doors[c] > 0.05 ? 'open' : 'closed'}</dd></div>)}
                    <div><dt>Order</dt><dd>{o ? `${o.id} · ${STATUS[o.status]}` : 'none'}</dd></div>
                    <div><dt>Trips</dt><dd>{d.orders.filter((x) => x.robot_session === r.session).length} · sim {r.speed}×</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="op-sec">
        <h2>Needs a person {d.escalations.length > 0 && <span className="op-count">{d.escalations.length}</span>}</h2>
        {d.escalations.length === 0 ? <p className="op-empty">All clear. Sensor disagreements, failed payments, stuck orders and robots that drop offline show up here.</p> : (
          <div className="op-queue">
            {d.escalations.map((e) => {
              const o = d.orders.find((x) => x.id === e.order_id)!;
              const cs = comps(o.id);
              const note = notes[e.order_id] ?? '';
              const body = (x: Record<string, unknown>) => ({ ...x, order_id: o.id, note });
              return (
                <article key={`${e.order_id}${e.kind}`} className={`op-esc ${e.severity}`}>
                  <div className="op-esc-top">
                    <span className={`op-chip ${e.severity}`}>{e.severity === 'urgent' ? 'Urgent' : 'Review'}</span>
                    <b>{e.title}</b>
                    <span className="op-soft">{o.id} · {ago(e.since, now)}</span>
                  </div>
                  <ul>{e.detail.map((l) => <li key={l}>{l}</li>)}</ul>
                  <div className="op-actions">
                    <input aria-label={`Note for ${o.id}`} placeholder="Note (optional)" value={note} onChange={(ev) => setNotes((n) => ({ ...n, [o.id]: ev.target.value }))} />
                    {e.actions.includes('settle') && <>
                      {cs.map((c) => <Confirm key={c.id} label={`Charge ${c.id} only · ${$(c.value_cents)}`} onGo={() => act(body({ action: 'settle', charge: [c.id] }), `Charged compartment ${c.id} on ${o.id}.`)} />)}
                      {cs.length > 1 && <Confirm label={`Charge all · ${$(o.total_cents)}`} onGo={() => act(body({ action: 'settle', charge: cs.map((c) => c.id) }), `Charged all of ${o.id}.`)} />}
                      <Confirm danger label="Release everything" onGo={() => act(body({ action: 'settle', charge: [] }), `Released ${o.id}; customer not charged.`)} />
                    </>}
                    {e.actions.includes('cancel') && <Confirm danger label={`Cancel · release ${$(o.total_cents)}`} onGo={() => act(body({ action: 'cancel' }), `Cancelled ${o.id}; money returned.`)} />}
                    {e.actions.includes('release') && <Confirm danger label={`Return ${$(o.total_cents)} to customer`} onGo={() => act(body({ action: 'release' }), `Returned the money on ${o.id}.`)} />}
                    {e.actions.includes('resolve') && <Confirm label="Mark resolved" onGo={() => act(body({ action: 'resolve' }), `${o.id} marked resolved.`)} />}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="op-sec">
        <h2>Recent orders</h2>
        <div className="op-tablewrap">
          <table className="op-table">
            <thead><tr><th>Order</th><th>Placed</th><th>To</th><th>Shops</th><th>Robot</th><th>Status</th><th className="num">Total</th><th className="num">Charged</th></tr></thead>
            <tbody>
              {d.orders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.id}</td>
                  <td>{ago(o.created_at, now)}</td>
                  <td>L{o.location.startsWith('L20') ? 20 : 23}</td>
                  <td>{comps(o.id).map((c) => d.shops.find((s) => s.id === c.shop_id)?.name ?? c.shop_id).join(', ')}</td>
                  <td>{name(o.robot_session)}</td>
                  <td><span className={`op-chip ${tone(o.status)}`}>{STATUS[o.status] ?? o.status}</span></td>
                  <td className="num">{$(o.total_cents)}</td>
                  <td className="num">{$(o.captured_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.ops.length > 0 && (
        <section className="op-sec">
          <h2>Operator log</h2>
          <ul className="op-log">
            {[...d.ops].reverse().map((e) => <li key={e.id}><span className="op-soft">{new Date(e.at).toLocaleTimeString()}</span> <b>{String(e.payload.action)}</b> on <span className="mono">{e.order_id}</span>{e.payload.note ? ` · “${String(e.payload.note)}”` : ''}</li>)}
          </ul>
        </section>
      )}
    </main>
  );
}
