'use client';

// The customer's phone: ask for food, pay (PayPal holds, doesn't charge), follow the robot,
// take the bag, get a receipt for exactly what was taken. Used full screen at /order and
// inside the phone frame on the split-screen home page.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Compartment, Item, LedgerRow, Order, Shop } from '../lib/db.ts';

type Detail = { order: Order; compartments: Compartment[]; ledger: LedgerRow[]; decision: { action: string; charge_compartments: string[]; at: string } | null; lines: { item_id: string; compartment_id: string; qty: number; name: string }[] };
type Menu = { items: Item[]; shops: Shop[] };
type Config = { mode: 'mock' | 'sandbox'; clientId: string | null };
export type RobotLive = { floor: number; phase: string } | null;

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const KEY = 'liftdrop-order';
const DONE = ['captured', 'partially_captured', 'paying_out', 'paid_out'];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

export default function OrderApp({ robot = null }: { robot?: RobotLive }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [orderId, setOrderId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Menu>('/api/state').then((s) => setMenu({ items: s.items, shops: s.shops })).catch((e) => setError(e.message));
    api<Config>('/api/config').then(setConfig).catch(() => setConfig({ mode: 'mock', clientId: null }));
    setOrderId(store.get());
  }, []);

  // Follow the order once a second until it's finished.
  useEffect(() => {
    if (!orderId) return void setDetail(null);
    let stop = false;
    const tick = () => api<Detail>(`/api/orders/${orderId}`).then((d) => { if (!stop) setDetail(d); }).catch((e) => {
      if (!stop && /not found/.test(e.message)) { store.set(null); setOrderId(null); }
    });
    tick();
    const t = setInterval(tick, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [orderId]);

  const started = (id: string) => { store.set(id); setOrderId(id); setCart({}); };
  const reset = () => { store.set(null); setOrderId(null); setDetail(null); setError(''); };

  return (
    <div className="phone-app">
      <header className="app-bar">
        <span className="brand">LiftDrop</span>
        <span className="deliver-to">To Level 23 pantry</span>
      </header>
      {error && <p className="app-error" role="alert">{error}</p>}
      {!menu ? <p className="muted pad">Loading the menu…</p>
        : orderId && detail ? <Tracking d={detail} shops={menu.shops} robot={robot} onNew={reset} onError={setError} />
        : orderId ? <p className="muted pad">Finding your order…</p>
        : <Shop menu={menu} cart={cart} setCart={setCart} config={config} onStarted={started} onError={setError} />}
    </div>
  );
}

// ---------- ordering ----------

function Shop({ menu, cart, setCart, config, onStarted, onError }: {
  menu: Menu; cart: Record<string, number>; setCart: (c: Record<string, number>) => void;
  config: Config | null; onStarted: (id: string) => void; onError: (m: string) => void;
}) {
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([item_id, qty]) => ({ item_id, qty }));
  const total = lines.reduce((s, l) => s + (menu.items.find((i) => i.id === l.item_id)?.price_cents ?? 0) * l.qty, 0);
  const add = (id: string, d: number) => setCart({ ...cart, [id]: Math.max(0, Math.min(5, (cart[id] ?? 0) + d)) });
  // The robot has two compartments, one per shop.
  const inCart = new Set(lines.map((l) => menu.items.find((i) => i.id === l.item_id)?.shop_id));
  const full = inCart.size >= 2;

  return (
    <div className="shop">
      <Assistant onCart={(ls) => setCart(Object.fromEntries(ls.map((l) => [l.item_id, l.qty])))} onError={onError} />
      {menu.shops.map((shop) => (
        <section key={shop.id} className="menu-shop">
          <h2>{shop.name}</h2>
          {full && !inCart.has(shop.id) && <p className="muted small">The robot carries from two shops per trip. Remove one to order here.</p>}
          {menu.items.filter((i) => i.shop_id === shop.id).map((i) => (
            <div key={i.id} className="menu-item">
              <div>
                <div className="item-name">{i.name}</div>
                <div className="muted small">{$(i.price_cents)}</div>
              </div>
              <div className="stepper">
                {(cart[i.id] ?? 0) > 0 && <>
                  <button aria-label={`One less ${i.name}`} onClick={() => add(i.id, -1)}>−</button>
                  <span aria-live="polite">{cart[i.id]}</span>
                </>}
                <button aria-label={`Add ${i.name}`} disabled={full && !inCart.has(i.shop_id)} onClick={() => add(i.id, 1)}>+</button>
              </div>
            </div>
          ))}
        </section>
      ))}
      <div className="checkout">
        {lines.length === 0 ? <p className="muted small">Add something, or ask above.</p> : <>
          <div className="total-row"><span>Total</span><strong>{$(total)}</strong></div>
          <p className="hold-note">PayPal holds {$(total)} now. You’re charged only for what you take out of the robot.</p>
          <Pay lines={lines} config={config} onStarted={onStarted} onError={onError} />
        </>}
      </div>
    </div>
  );
}

function Assistant({ onCart, onError }: { onCart: (l: { item_id: string; qty: number }[]) => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async (message: string) => {
    if (!message.trim()) return;
    setBusy(true); setReply('');
    try {
      const r = await api<{ lines: { item_id: string; qty: number }[]; reply: string }>('/api/assistant', { message });
      setReply(r.reply);
      if (r.lines.length) onCart(r.lines);
    } catch (e) { onError((e as Error).message); }
    setBusy(false);
  };
  return (
    <form className="assistant" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
      <label htmlFor="ask">What would you like?</label>
      <div className="ask-row">
        <input id="ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="A croissant and something cold" autoComplete="off" />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
      </div>
      {reply && <p className="assistant-reply" role="status">{reply}</p>}
    </form>
  );
}

// ---------- paying ----------

type PayPalNS = { Buttons: (o: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close?: () => void } };
const sdk: Record<string, Promise<PayPalNS>> = {};
function loadPayPal(clientId: string) {
  return (sdk[clientId] ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=authorize&components=buttons`;
    s.onload = () => ok((window as unknown as { paypal: PayPalNS }).paypal);
    s.onerror = () => fail(new Error('PayPal could not load. Check your connection and reload.'));
    document.head.appendChild(s);
  }));
}

function Pay({ lines, config, onStarted, onError }: {
  lines: { item_id: string; qty: number }[]; config: Config | null; onStarted: (id: string) => void; onError: (m: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const cb = useRef({ onStarted, onError }); // parent callbacks change identity; the PayPal button must not re-render
  cb.current = { onStarted, onError };
  const [busy, setBusy] = useState(false);

  const create = useCallback(() => api<Order>('/api/orders', { location: 'L23-pantry', cart: linesRef.current }), []);

  // Sandbox: the real PayPal button. The popup approves; our server then authorizes (holds).
  useEffect(() => {
    if (config?.mode !== 'sandbox' || !config.clientId || !box.current) return;
    let ours: string | null = null;
    let closed = false;
    const el = box.current;
    loadPayPal(config.clientId).then((paypal) => {
      if (closed) return;
      const b = paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 44 },
        createOrder: async () => { const o = await create(); ours = o.id; return o.paypal_order_id; },
        onApprove: async () => {
          try { await api('/api/authorize', { order_id: ours }); cb.current.onStarted(ours!); }
          catch (e) { cb.current.onError((e as Error).message); }
        },
        onCancel: () => cb.current.onError('Payment cancelled. Nothing was held.'),
        onError: (e: unknown) => cb.current.onError(`PayPal: ${e instanceof Error ? e.message : String(e)}`),
      });
      el.innerHTML = '';
      return b.render(el);
    }).catch((e) => cb.current.onError(e.message));
    return () => { closed = true; el.innerHTML = ''; };
  }, [config, create]);

  if (!config) return null;
  if (config.mode === 'sandbox') return <div ref={box} className="paypal-box" />;
  return (
    <button className="pay-test" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const o = await create();
        await api('/api/authorize', { order_id: o.id });
        onStarted(o.id);
      } catch (e) { onError((e as Error).message); setBusy(false); }
    }}>{busy ? 'Holding payment…' : 'Pay with PayPal (test mode)'}</button>
  );
}

// ---------- after paying ----------

const STEPS = ['Payment held', 'Picking up', 'In the lift', 'At your floor', 'Receipt'] as const;

function stepOf(d: Detail): number {
  const s = d.order.status;
  if (s === 'created' || s === 'held') return 0;
  if (s === 'collecting') return 1;
  if (s === 'en_route') return 2;
  if (s === 'at_door') return 3;
  return 4;
}

function Floor({ d, robot }: { d: Detail; robot: RobotLive }) {
  const s = d.order.status;
  // Live from the sim when it runs on this page; otherwise from the order status.
  const floor = robot ? robot.floor : s === 'at_door' || DONE.includes(s) ? 23 : 0;
  const up = robot ? /lift ↑/.test(robot.phase) : s === 'en_route';
  const down = robot ? /returning|dock/.test(robot.phase) && floor > 0 : false;
  return (
    <div className="led" aria-label={`Robot on ${floor === 0 ? 'ground floor' : `level ${floor}`}`}>
      <span className="led-arrow">{up ? '▲' : down ? '▼' : ''}</span>
      <span className="led-num">{floor === 0 ? 'G' : floor}</span>
    </div>
  );
}

function Tracking({ d, shops, robot, onNew, onError }: { d: Detail; shops: Shop[]; robot: RobotLive; onNew: () => void; onError: (m: string) => void }) {
  const { order, compartments, lines, ledger, decision } = d;
  const step = stepOf(d);
  const sum = (k: string) => ledger.filter((l) => l.kind === k).reduce((s, l) => s + l.amount_cents, 0);
  // Optimistic "checking" between the tap and the next poll that shows it.
  const [tapped, setTapped] = useState<string | null>(null);
  const doneAt = order.customer_done_at;
  const pending = tapped !== null && tapped === (doneAt ?? '');
  // The agent asked the customer to check a compartment, after their latest tap.
  const asked = order.status === 'at_door' && decision?.action === 'wait' && !!doneAt && Date.parse(decision.at) >= Date.parse(doneAt) && !pending;
  const checking = order.status === 'at_door' && !asked && (pending || !!doneAt);
  const shopName = (id: string) => shops.find((s) => s.id === id)?.name ?? id;
  const waitingAt = compartments.find((c) => !c.loaded);

  const headline =
    order.status === 'created' ? 'Waiting for PayPal'
    : order.status === 'held' ? 'Robot is heading to the shops'
    : order.status === 'collecting' ? `Picking up at ${waitingAt ? shopName(waitingAt.shop_id) : 'the shops'}`
    : order.status === 'en_route' ? 'On its way up to you'
    : order.status === 'at_door' ? (asked ? 'One more check' : checking ? 'Checking what you took…' : 'Your robot is at the pantry')
    : DONE.includes(order.status) ? 'Delivered'
    : order.status === 'voided' || order.status === 'returning' ? 'Not delivered, not charged'
    : order.captured_cents > 0 ? 'Charged, payout delayed' : 'Something went wrong. You haven’t been charged.';

  return (
    <div className="tracking">
      <div className="track-head">
        <Floor d={d} robot={robot} />
        <div>
          <h1 className="headline">{headline}</h1>
          <p className="muted small">Order {order.id}</p>
        </div>
      </div>

      <ol className="steps" aria-label="Delivery progress">
        {STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>{s}</li>)}
      </ol>

      {order.status === 'at_door' && !checking && !asked && (
        <div className="door-card">
          <p>Compartment{compartments.length > 1 ? 's' : ''} {compartments.map((c) => c.id).join(' and ')} {compartments.length > 1 ? 'are' : 'is'} open.</p>
          <ul className="bag-list">
            {compartments.map((c) => (
              <li key={c.id}><span className="comp-tag">{c.id}</span>{lines.filter((l) => l.compartment_id === c.id).map((l) => `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}`).join(', ')}</li>
            ))}
          </ul>
          <p className="muted small">Take what you want. Anything you leave goes back to the shop and isn’t charged.</p>
          <button className="primary" onClick={async () => {
            setTapped(doneAt ?? '');
            try { await api(`/api/orders/${order.id}`, { action: 'done' }); } catch (e) { setTapped(null); onError((e as Error).message); }
          }}>I’ve taken my order</button>
        </div>
      )}

      {asked && (
        <div className="door-card">
          <p>{order.customer_message}</p>
          <button className="primary" onClick={async () => {
            setTapped(doneAt ?? '');
            try { await api(`/api/orders/${order.id}`, { action: 'done' }); } catch (e) { setTapped(null); onError((e as Error).message); }
          }}>Done</button>
        </div>
      )}

      {step === 4 && (
        <div className="receipt">
          {order.customer_message && <p className="receipt-msg">{order.customer_message}</p>}
          <div className="receipt-row"><span>Held</span><span>{$(sum('held'))}</span></div>
          <div className="receipt-row"><span>Charged</span><strong>{$(sum('captured'))}</strong></div>
          <div className="receipt-row"><span>Released back to you</span><span>{$(sum('voided'))}</span></div>
          <ul className="bag-list">
            {compartments.map((c) => {
              const charged = DONE.includes(order.status) && !!decision?.charge_compartments.includes(c.id);
              const names = lines.filter((l) => l.compartment_id === c.id).map((l) => l.name).join(', ');
              return <li key={c.id}><span className="comp-tag">{c.id}</span>{names} <em className={charged ? 'ok' : 'muted'}>{charged ? 'taken' : 'returned to shop'}</em></li>;
            })}
          </ul>
          <button className="secondary" onClick={onNew}>Order again</button>
        </div>
      )}
      {step < 4 && order.status !== 'at_door' && (
        <p className="hold-note">{$(order.total_cents)} held by PayPal. Nothing is charged until you take your order.</p>
      )}
    </div>
  );
}
