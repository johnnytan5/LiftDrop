'use client';

// Shop counter tablet (Coral Plate design): bags to pack for the robot, what the shop earned,
// and every recent order with its outcome. A bag that came back says why, from the robot's scale
// and compartment camera. Staff confirm loading on the robot's own screen, not here.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Compartment, Decision, Item, LedgerRow, Order, OrderItem, Shop } from '../../lib/db.ts';
import { byShopOrder, itemPhoto, shopArt, shopPhoto } from '../../lib/menu-art.ts';

type State = { shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[]; order_items: OrderItem[]; ledger: LedgerRow[]; decisions: Decision[] };
type Fact = { compartment: string; weight: true | false | 'ambiguous'; camera: 'gone' | 'present' | 'partial' | 'unknown'; end_g: number | null; expected_g: number };
type Outcome = { tone: 'sold' | 'live' | 'back' | 'bad'; label: string; detail?: string; net?: number; fee?: number; paid?: boolean };

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const LIVE: Record<string, string> = { held: 'Paid, robot on its way', collecting: 'Robot at the counters', en_route: 'In the lift', at_door: 'At the customer’s door' };
const SOLD = ['captured', 'partially_captured', 'paying_out', 'paid_out'];
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What happened to this shop's bag in one order, and the sensors' reason if it came back. */
function outcome(s: State, c: Compartment, o: Order): Outcome {
  if (LIVE[o.status]) return { tone: 'live', label: LIVE[o.status] };
  const rows = s.ledger.filter((l) => l.order_id === o.id && l.shop_id === c.shop_id);
  const net = rows.find((l) => l.kind === 'payout_pending')?.amount_cents;
  const fee = rows.find((l) => l.kind === 'fee')?.amount_cents;
  const paid = rows.some((l) => l.kind === 'paid_out');
  const applied = s.decisions.filter((d) => d.order_id === o.id).at(-1)?.applied as { charge_compartments?: string[]; kept?: Record<string, number> } | undefined;
  if (net !== undefined && applied?.kept?.[c.id] && !applied.charge_compartments?.includes(c.id)) {
    return { tone: 'sold', label: paid ? 'Final sale · paid to you' : 'Final sale · payout on its way', detail: 'Not collected, charged as final sale.', net, fee, paid };
  }
  if (net !== undefined) return { tone: 'sold', label: paid ? 'Sold · paid to you' : 'Sold · payout on its way', net, fee, paid };
  if (o.status === 'failed') return { tone: 'back', label: 'Uncollected · refunded', detail: 'The customer wasn’t charged for this. The robot brings it back to your counter.' };
  if (SOLD.includes(o.status) || o.status === 'voided' || o.status === 'returning') {
    const last = s.decisions.filter((d) => d.order_id === o.id).at(-1);
    const f = (last?.facts as Fact[] | undefined)?.find((x) => x.compartment === c.id);
    const why = !f ? 'Not collected.'
      : [f.end_g !== null ? `scale still read ${f.end_g} g of ${f.expected_g} g` : 'the door wasn’t opened',
         f.camera === 'present' ? 'camera still saw it' : f.camera === 'partial' ? 'camera saw part of it' : f.camera === 'gone' ? 'camera saw it gone' : null]
        .filter(Boolean).join(', ');
    return { tone: 'back', label: 'Came back to your counter', detail: `${why[0].toUpperCase()}${why.slice(1)}${why.endsWith('.') ? '' : '.'} Not charged.` };
  }
  return { tone: 'live', label: o.status };
}

export default function Vendor() {
  const [s, setS] = useState<State | null>(null);
  const [shop, setShop] = useState('bakery');
  const [err, setErr] = useState('');

  // Switch flips the user made that the server hasn't confirmed yet, and when the last one saved:
  // a poll that left before that save carries the old value, so it's dropped instead of flipping back.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const savedAt = useRef(0);
  const refresh = useCallback(() => {
    const sent = Date.now();
    return fetch('/api/state', { cache: 'no-store' }).then((r) => r.json())
      .then((next: State) => { if (sent >= savedAt.current) setS(next); }).catch(() => {});
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('shop');
    if (q) setShop(q);
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!s) return <main className="cp-app vd"><p className="cp-pad cp-soft">Loading…</p></main>;
  const shops = byShopOrder(s.shops);
  const me = shops.find((x) => x.id === shop) ?? shops[0];
  const art = shopArt(me.id);
  const orderOf = (c: Compartment) => s.orders.find((o) => o.id === c.order_id)!;
  const mine = s.compartments.filter((c) => c.shop_id === me.id && orderOf(c) && orderOf(c).status !== 'created');
  // The robot's current order (the newest one it claimed) first: that's the bag it's waiting for.
  const toLoad = mine.filter((c) => !c.loaded && ['held', 'collecting'].includes(orderOf(c).status))
    .sort((a, b) => Number(!!orderOf(b).robot_session) - Number(!!orderOf(a).robot_session) || Date.parse(orderOf(b).created_at) - Date.parse(orderOf(a).created_at));
  const next = toLoad.find((c) => orderOf(c).robot_session);
  const lines = (c: Compartment) => s.order_items.filter((l) => l.order_id === c.order_id && l.compartment_id === c.id);
  const name = (id: string) => s.items.find((i) => i.id === id)?.name ?? id;
  const rows = s.ledger.filter((l) => l.shop_id === me.id);
  const total = (k: string) => rows.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_cents, 0);
  const recent = [...mine].sort((a, b) => Date.parse(orderOf(b).created_at) - Date.parse(orderOf(a).created_at)).slice(0, 12);
  const menu = s.items.filter((i) => i.shop_id === me.id);
  const setFinal = (id: string, final_sale: boolean) => {
    setPending((p) => ({ ...p, [id]: final_sale }));
    fetch(`/api/items/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ final_sale }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); setErr(''); })
      .catch((e) => setErr(e.message))
      .finally(async () => {
        savedAt.current = Date.now();
        await refresh();
        setPending(({ [id]: _, ...rest }) => rest);
      });
  };
  const sold = recent.filter((c) => outcome(s, c, orderOf(c)).tone === 'sold').length;
  const back = recent.filter((c) => outcome(s, c, orderOf(c)).tone === 'back').length;

  return (
    <main className="cp-app vd">
      <header className="vd-head">
        <img className="vd-logo" src={shopPhoto(me.id, 240)} alt="" />
        <div className="vd-title">
          <span className="cp-k">LiftDrop for shops</span>
          <h1>{me.name}</h1>
          <p>{art.tagline} · {art.counter}</p>
        </div>
        <nav className="vd-tabs" aria-label="Shop">
          {shops.map((x) => (
            <button key={x.id} aria-pressed={x.id === me.id} onClick={() => { setShop(x.id); const u = new URL(location.href); u.searchParams.set('shop', x.id); history.replaceState(null, '', u); /* keeps /demo's ?view= */ }}>
              <img src={shopPhoto(x.id, 80)} alt="" />{x.name}
            </button>
          ))}
        </nav>
      </header>
      {err && <p className="cp-error" role="alert">{err}</p>}

      <section className="vd-section">
        <div className="vd-h2"><h2>Bags for the robot</h2>{toLoad.length > 0 && <span className="vd-count">{toLoad.length}</span>}</div>
        {toLoad.length === 0 ? <p className="vd-empty">Nothing to pack. New orders show up here the moment the customer pays.</p> : toLoad.map((c) => (
          <div key={`${c.order_id}${c.id}`} className={`vd-load${c === next ? ' is-next' : ''}`}>
            <span className="vd-comp" aria-label={`Compartment ${c.id}`}>Slot<b>{c.id}</b></span>
            <span className="cp-bagthumbs">{lines(c).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 120)} alt="" />)}</span>
            <div className="vd-load-main">
              <b>{lines(c).map((l) => `${l.qty}× ${name(l.item_id)}`).join(', ')}</b>
              <small>Order {c.order_id} · {$(c.value_cents)} · {c === next ? 'robot coming for this bag' : 'waiting for a robot'}</small>
            </div>
            {c.vendor_loaded_at ? <span className="vd-closing">Robot is closing compartment {c.id}</span>
              : <span className="vd-hint">{c === next ? `Put it in slot ${c.id}, then tap Loaded on the robot’s screen` : 'Pack it; the robot will ask for it'}</span>}
          </div>
        ))}
      </section>

      <section className="vd-section">
        <div className="vd-h2"><h2>Your menu</h2><span className="cp-soft vd-sub">Final sale: charged even if the customer doesn’t collect it</span></div>
        <ul className="vd-menu">
          {menu.map((i) => (
            <li key={i.id}>
              <img src={itemPhoto(i.id, 120)} alt="" />
              <span className="vd-menu-main"><b>{i.name}</b><small>{$(i.price_cents)}{(pending[i.id] ?? i.final_sale) ? ' · no refund if not collected' : ' · refunded if not collected'}</small></span>
              <label className="vd-switch">
                <input type="checkbox" role="switch" checked={pending[i.id] ?? !!i.final_sale} onChange={(e) => setFinal(i.id, e.target.checked)} />
                <span>Final sale</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="vd-section">
        <div className="vd-h2"><h2>Earnings</h2></div>
        <div className="vd-kpis">
          <div className="vd-kpi hero"><span>Paid to you</span><b>{$(total('paid_out'))}</b><small>Sent by PayPal Payouts</small></div>
          <div className="vd-kpi"><span>On its way</span><b>{$(total('payout_pending') - total('paid_out'))}</b><small>Payouts still processing</small></div>
          <div className="vd-kpi"><span>LiftDrop fee</span><b>{$(total('fee'))}</b><small>{me.fee_bps / 100}% of what customers took</small></div>
        </div>
      </section>

      <section className="vd-section">
        <div className="vd-h2"><h2>Recent orders</h2><span className="cp-soft vd-sub">{sold} sold · {back} came back</span></div>
        {recent.length === 0 ? <p className="vd-empty">No orders yet.</p> : (
          <ul className="vd-orders">
            {recent.map((c) => {
              const o = orderOf(c);
              const out = outcome(s, c, o);
              return (
                <li key={`${c.order_id}${c.id}`} className={`vd-order ${out.tone}`}>
                  <span className="cp-bagthumbs">{lines(c).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 120)} alt="" />)}</span>
                  <div className="vd-order-main">
                    <b>{lines(c).map((l) => `${l.qty}× ${name(l.item_id)}`).join(', ')}</b>
                    <small>{time(o.created_at)} · Order {o.id}{out.detail ? ` · ${out.detail}` : ''}</small>
                  </div>
                  <span className={`vd-chip ${out.tone}`}>{out.label}</span>
                  <span className="vd-money">
                    {out.net !== undefined ? <><b>{$(out.net)}</b><small>{$(out.net + (out.fee ?? 0))} − {$(out.fee ?? 0)} fee</small></>
                      : out.tone === 'back' || out.tone === 'bad' ? <><b className="vd-zero">$0.00</b><small>{$(c.value_cents)} not charged</small></>
                      : <><b className="cp-soft">{$(c.value_cents)}</b><small>if collected</small></>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="vd-foot">Customers pay only for what they take out of the robot. Its scale and compartment camera check every bag; anything left comes back to your counter and isn’t charged, unless you marked it final sale above.</p>
      </section>
    </main>
  );
}
