'use client';

// The customer's phone (Coral Plate design): browse the four lobby shops or call the order line,
// pay (PayPal holds, doesn't charge), follow the robot, take the bag, get a receipt for exactly
// what was taken. Full screen at /order, inside the phone frame on the split-screen home page.

import { useEffect, useRef, useState } from 'react';
import type { Item, Shop } from '../lib/db.ts';
import { byPopular, byShopOrder, HERO, itemPhoto, itemUnit, shopArt, shopPhoto } from '../lib/menu-art.ts';
import Pay from './Pay.tsx';
import CallScreen from './CallScreen.tsx';
import { Brand } from './Brand.tsx';
import Countdown from './Countdown.tsx';
import { $, api, cartCount, cartLines, cartShops, cartTotal, DONE, headlineOf, MAX_SHOPS, OFFICES, ACCOUNT, type Cart, type Config, type Detail, type Menu, type OfficeFloor } from './order-shared.ts';

export type RobotLive = { floor: number; phase: string } | null;
type Screen = 'home' | 'shop' | 'basket' | 'call' | 'orders' | 'track';
// The robot is still out with this order: Home shows a banner, the Orders tab a live dot.
const LIVE = ['held', 'collecting', 'en_route', 'at_door'];

const KEY = 'liftdrop-order';
const FLOOR_KEY = 'liftdrop-floor';
const HISTORY_KEY = 'liftdrop-orders'; // this phone's orders, newest first
const CODES_KEY = 'liftdrop-codes'; // order id -> the code that opens the robot; only this phone has it
const readCodes = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(CODES_KEY) ?? '{}') ?? {}; } catch { return {}; } };
const MAX_HISTORY = 20;
const readHistory = (): string[] => { try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const saveHistory = (ids: string[]) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(ids)); } catch { /* private mode */ } };
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

export default function OrderApp({ robot = null }: { robot?: RobotLive }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [screen, setScreen] = useState<Screen>('home');
  const [shopId, setShopId] = useState('noodles');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [floor, setFloorState] = useState<OfficeFloor>(23);
  const [history, setHistory] = useState<string[]>([]);
  const setFloor = (f: OfficeFloor) => { setFloorState(f); try { localStorage.setItem(FLOOR_KEY, String(f)); } catch { /* private mode */ } };

  useEffect(() => {
    api<Menu>('/api/state').then((s) => setMenu({ items: byPopular(s.items), shops: byShopOrder(s.shops) })).catch((e) => setError(e.message));
    api<Config>('/api/config').then(setConfig).catch(() => setConfig({ mode: 'mock', clientId: null }));
    const current = store.get();
    setOrderId(current);
    if (current) setScreen('track');
    const h = readHistory();
    // Orders placed before the list existed: keep the current one in it.
    if (current && !h.includes(current)) h.unshift(current);
    setHistory(h);
    try { if (localStorage.getItem(FLOOR_KEY) === '20') setFloorState(20); } catch { /* private mode */ }
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

  const root = useRef<HTMLDivElement>(null);
  const go = (s: Screen) => { setScreen(s); setError(''); root.current?.scrollTo({ top: 0 }); };
  const orderRef = useRef<string | null>(null);
  orderRef.current = orderId;
  const paid = (id: string, code: string) => {
    store.set(id); setOrderId(id); setCart({}); setFromList(false);
    try { localStorage.setItem(CODES_KEY, JSON.stringify({ ...readCodes(), [id]: code })); } catch { /* private mode */ }
    setHistory((h) => { const n = [id, ...h.filter((x) => x !== id)].slice(0, MAX_HISTORY); saveHistory(n); return n; });
  };
  const [fromList, setFromList] = useState(false); // tracking opened from My orders: show a back arrow
  const open = (id: string) => { store.set(id); setOrderId(id); setFromList(true); go('track'); };
  const reset = () => { store.set(null); setOrderId(null); setDetail(null); setError(''); go('home'); };

  if (!menu) return <div className="cp-app"><p className="cp-pad cp-soft">Loading the shops…</p></div>;

  // The robot has two compartments: once two shops are in the basket, the others wait.
  const shopsIn = cartShops(menu, cart);
  const blocked = (i: Item) => shopsIn.length >= MAX_SHOPS && !shopsIn.includes(i.shop_id);
  const bump = (id: string, d: number) => setCart((c) => {
    const q = Math.max(0, Math.min(5, (c[id] ?? 0) + d));
    const n = { ...c };
    if (q) n[id] = q; else delete n[id];
    return n;
  });
  const shared = { menu, cart, bump, blocked, floor };

  let body;
  if (screen === 'call') {
    body = <CallScreen menu={menu} cart={cart} setCart={setCart} config={config} detail={detail} floor={floor} setFloor={setFloor} onPaid={paid} onClose={(next) => go(next ?? (orderRef.current ? 'track' : 'home'))} />;
  } else if (screen === 'orders') {
    body = <MyOrders ids={history} shops={menu.shops} onOpen={open} />;
  } else if (screen === 'track' && orderId && detail) {
    body = <Tracking d={detail} shops={menu.shops} robot={robot} onNew={reset} onError={setError} onBack={fromList ? () => go('orders') : undefined} />;
  } else if (screen === 'track' && orderId) {
    body = <p className="cp-pad cp-soft">Finding your order…</p>;
  } else if (screen === 'shop') {
    body = <ShopMenu {...shared} shop={menu.shops.find((s) => s.id === shopId) ?? menu.shops[0]} onBack={() => go('home')} onBasket={() => go('basket')} />;
  } else if (screen === 'basket') {
    body = <Basket {...shared} config={config} onBack={() => go('home')} onPaid={(id, code) => { paid(id, code); go('track'); }} onError={setError} />;
  } else {
    body = <Home {...shared} setFloor={setFloor} onShop={(id) => { setShopId(id); go('shop'); }} onCall={() => go('call')} onBasket={() => go('basket')}
      live={orderId && detail && LIVE.includes(detail.order.status) ? headlineOf(detail, menu.shops) : null} onTrack={() => go('track')} />;
  }
  const live = !!(orderId && detail && LIVE.includes(detail.order.status));
  const tab = screen === 'track' || screen === 'orders' ? 'orders' : screen === 'shop' ? 'home' : screen;

  return (
    <div ref={root} className={`cp-app${screen === 'call' ? ' cp-oncall' : ''}`}>
      {error && <p className="cp-error" role="alert">{error}</p>}
      {body}
      {screen !== 'call' && (
        <nav className="cp-tabs" aria-label="App">
          {([['home', 'Home', HOME], ['call', 'Call', PHONE], ['basket', 'Basket', BAG], ['orders', 'Orders', RECEIPT]] as const).map(([id, label, icon]) => (
            <button key={id} aria-current={tab === id ? 'page' : undefined}
              onClick={() => go(id === 'orders' ? (live ? 'track' : 'orders') : id)}>
              <span className="cp-tabicon">
                <Icon d={icon} size={20} width={tab === id ? 2.3 : 1.8} />
                {id === 'basket' && cartCount(cart) > 0 && <span className="cp-tabbadge">{cartCount(cart)}</span>}
                {id === 'orders' && live && <span className="cp-tabdot" aria-label="delivery in progress" />}
              </span>
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

// ---------- pieces ----------

type Shared = { menu: Menu; cart: Cart; bump: (id: string, d: number) => void; blocked: (i: Item) => boolean; floor: OfficeFloor };

function Icon({ d, size = 18, stroke = 'currentColor', width = 2 }: { d: string; size?: number; stroke?: string; width?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d.split('|').map((p) => <path key={p} d={p} />)}</svg>;
}
const PHONE = 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z';
const BACK = 'm15 18-6-6 6-6';
const HOME = 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z';
const BAG = 'M6 7h12l1 14H5L6 7Z|M9 7V5a3 3 0 0 1 6 0v2';
const RECEIPT = 'M6 2h12v20l-3-2-3 2-3-2-3 2V2Z|M9 7h6|M9 11h6|M9 15h4';

function Stepper({ item, qty, bump, blocked }: { item: Item; qty: number; bump: Shared['bump']; blocked: boolean }) {
  if (!qty) return <button className="cp-plus" aria-label={`Add ${item.name}`} disabled={blocked} title={blocked ? 'The robot carries from two shops per trip' : undefined} onClick={() => bump(item.id, 1)}>+</button>;
  return (
    <span className="cp-stepper">
      <button aria-label={`One less ${item.name}`} onClick={() => bump(item.id, -1)}>−</button>
      <span aria-live="polite">{qty}</span>
      <button className="on" aria-label={`Add ${item.name}`} onClick={() => bump(item.id, 1)}>+</button>
    </span>
  );
}

function TwoShopNote({ menu, cart }: { menu: Menu; cart: Cart }) {
  const s = cartShops(menu, cart);
  if (s.length < MAX_SHOPS) return null;
  return <p className="cp-note">The robot carries from two shops per trip: {s.map((id) => menu.shops.find((x) => x.id === id)?.name).join(' and ')}. Remove one to order from another shop.</p>;
}

function CartBar({ menu, cart, floor, onBasket }: { menu: Menu; cart: Cart; floor: OfficeFloor; onBasket: () => void }) {
  const n = cartCount(cart);
  if (!n) return null;
  const k = cartShops(menu, cart).length;
  return (
    <button className="cp-cartbar" onClick={onBasket}>
      <span className="cp-cartbar-text"><b>{n} {n === 1 ? 'item' : 'items'} · {k} {k === 1 ? 'shop' : 'shops'}</b><small>One robot brings it all to Level {floor}</small></span>
      <span className="cp-cartbar-total">{$(cartTotal(menu, cart))}</span>
    </button>
  );
}

// ---------- home ----------

function Home({ menu, cart, bump, blocked, floor, setFloor, onShop, onCall, onBasket, live, onTrack }: Shared & { setFloor: (f: OfficeFloor) => void; onShop: (id: string) => void; onCall: () => void; onBasket: () => void; live: string | null; onTrack: () => void }) {
  const shopName = (id: string) => menu.shops.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="cp-screen">
      <Brand />
      <header className="cp-top">
        <span className="cp-avatar" aria-hidden="true">{ACCOUNT.name.split(' ').map((w) => w[0]).join('')}</span>
        <label className="cp-floorpick">
          <span className="cp-k">Deliver to {ACCOUNT.name}</span>
          <select className="cp-where" value={floor} onChange={(e) => setFloor(Number(e.target.value) as OfficeFloor)}>
            {([20, 23] as const).map((f) => <option key={f} value={f}>Level {f} · {OFFICES[f]}</option>)}
          </select>
        </label>
      </header>
      {live && (
        <button className="cp-livebar" onClick={onTrack}>
          <span className="cp-tabdot" aria-hidden="true" /><span><b>{live}</b><small>Tap to track your robot</small></span><Icon d="m9 18 6-6-6-6" size={16} />
        </button>
      )}

      <section className="cp-hero">
        <h1>Lunch from the lobby</h1>
        <p>Four shops downstairs. One robot, one PayPal checkout.</p>
        <button className="cp-callbtn" onClick={onCall}><span><Icon d={PHONE} size={13} stroke="#fff" width={2.2} /></span>Call your order</button>
        <img src={HERO} alt="" />
      </section>

      <h2 className="cp-h2">Shops</h2>
      <div className="cp-shops">
        {menu.shops.map((s) => {
          const art = shopArt(s.id);
          return (
            <button key={s.id} className="cp-shop" onClick={() => onShop(s.id)}>
              <span className="cp-shopimg"><img src={shopPhoto(s.id)} alt="" />{art.isNew && <span className={`cp-new ${art.isNew}`}>New</span>}</span>
              <span>{s.name}</span>
            </button>
          );
        })}
      </div>

      <h2 className="cp-h2 cp-h2-menu">On the menu</h2>
      <TwoShopNote menu={menu} cart={cart} />
      <div className="cp-grid">
        {menu.items.map((i) => (
          <div key={i.id} className={`cp-card${blocked(i) ? ' is-blocked' : ''}`}>
            <img src={itemPhoto(i.id, 300)} alt="" />
            <div className="cp-card-name">{i.name}{i.final_sale && <span className="cp-final" title="Fresh food: charged even if you don’t collect it">Final sale</span>}</div>
            <div className="cp-card-where">{shopName(i.shop_id)} · {shopArt(i.shop_id).counter}</div>
            <div className="cp-card-foot"><span>{$(i.price_cents)}</span><Stepper item={i} qty={cart[i.id] ?? 0} bump={bump} blocked={blocked(i)} /></div>
          </div>
        ))}
      </div>
      <CartBar menu={menu} cart={cart} floor={floor} onBasket={onBasket} />
    </div>
  );
}

// ---------- one shop ----------

function ShopMenu({ menu, cart, bump, blocked, floor, shop, onBack, onBasket }: Shared & { shop: Shop; onBack: () => void; onBasket: () => void }) {
  const art = shopArt(shop.id);
  return (
    <div className="cp-screen">
      <div className="cp-navrow"><button className="cp-round" aria-label="Back" onClick={onBack}><Icon d={BACK} /></button></div>
      <header className="cp-shophead">
        <img src={shopPhoto(shop.id, 360)} alt="" />
        <h1>{shop.name}</h1>
        <p>{art.tagline} · {art.counter}</p>
      </header>
      <TwoShopNote menu={menu} cart={cart} />
      <div className="cp-list">
        {menu.items.filter((i) => i.shop_id === shop.id).map((i) => (
          <div key={i.id} className="cp-row">
            <img src={itemPhoto(i.id)} alt="" />
            <div className="cp-row-main"><b>{i.name}{i.final_sale && <span className="cp-final" title="Fresh food: charged even if you don’t collect it">Final sale</span>}</b><small>{itemUnit(i.id)}</small><span>{$(i.price_cents)}</span></div>
            <Stepper item={i} qty={cart[i.id] ?? 0} bump={bump} blocked={blocked(i)} />
          </div>
        ))}
      </div>
      <CartBar menu={menu} cart={cart} floor={floor} onBasket={onBasket} />
    </div>
  );
}

// ---------- basket ----------

function Basket({ menu, cart, bump, blocked, floor, config, onBack, onPaid, onError }: Shared & { config: Config | null; onBack: () => void; onPaid: (id: string, code: string) => void; onError: (m: string) => void }) {
  const lines = cartLines(cart);
  const shops = cartShops(menu, cart).map((id) => menu.shops.find((s) => s.id === id)!);
  const total = cartTotal(menu, cart);
  return (
    <div className="cp-screen">
      <div className="cp-navrow">
        <button className="cp-round" aria-label="Back" onClick={onBack}><Icon d={BACK} /></button>
        <h1 className="cp-title">Your basket</h1>
        <span className="cp-round-spacer" />
      </div>
      {!lines.length ? <p className="cp-empty">Your basket is empty. Add something from the shops, or call your order in.</p> : <>
        <div className="cp-route" aria-label="Robot route">
          <div className="cp-route-head"><span>One robot, {shops.length === 1 ? 'one stop' : 'two stops'}</span><span>Level {floor}</span></div>
          <ol>
            {shops.map((s) => <li key={s.id}>{s.name}</li>)}
            <li>Lift</li>
            <li className="end">Your gate</li>
          </ol>
        </div>
        {shops.map((s, n) => (
          <section key={s.id} className="cp-group">
            <div className="cp-group-head"><span>{s.name} · {shopArt(s.id).counter}</span><span>Compartment {n === 0 ? 'A' : 'B'}</span></div>
            {lines.filter((l) => menu.items.find((i) => i.id === l.item_id)?.shop_id === s.id).map((l) => {
              const i = menu.items.find((x) => x.id === l.item_id)!;
              return (
                <div key={i.id} className="cp-row">
                  <img src={itemPhoto(i.id)} alt="" />
                  <div className="cp-row-main"><b>{i.name}{i.final_sale && <span className="cp-final" title="Fresh food: charged even if you don’t collect it">Final sale</span>}</b><small>{itemUnit(i.id)}</small><span>{$(i.price_cents * l.qty)}</span></div>
                  <Stepper item={i} qty={l.qty} bump={bump} blocked={blocked(i)} />
                </div>
              );
            })}
          </section>
        ))}
        <div className="cp-sum">
          <div><span>Subtotal</span><span>{$(total)}</span></div>
          <div><span>Tower delivery</span><span>Free</span></div>
          <div className="total-row"><span>Total</span><span>{$(total)}</span></div>
        </div>
        <p className="cp-hold">PayPal holds {$(total)}; you’re charged only for what you take out. The robot’s scale and camera check, and anything you leave goes back to the shop.</p>
        <div className="cp-paybar"><Pay lines={lines} config={config} location={`L${floor}-gate`} label={`Pay with PayPal · ${$(total)}`} onStarted={onPaid} onError={onError} /></div>
      </>}
    </div>
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
  const floor = robot ? robot.floor : s === 'at_door' || DONE.includes(s) ? (d.order.location.startsWith('L20') ? 20 : 23) : 0;
  const up = robot ? /lift ↑/.test(robot.phase) : s === 'en_route';
  const down = robot ? /returning|dock/.test(robot.phase) && floor > 0 : false;
  return (
    <div className="led" aria-label={`Robot on ${floor === 0 ? 'ground floor' : `level ${floor}`}`}>
      <span className="led-arrow">{up ? '▲' : down ? '▼' : ''}</span>
      <span className="led-num">{floor === 0 ? 'G' : floor}</span>
    </div>
  );
}

function Tracking({ d, shops, robot, onNew, onError, onBack }: { d: Detail; shops: Shop[]; robot: RobotLive; onNew: () => void; onError: (m: string) => void; onBack?: () => void }) {
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
  const shopOf = (c: string) => shops.find((s) => s.id === compartments.find((x) => x.id === c)?.shop_id)?.name ?? '';
  const tapDone = async () => {
    setTapped(doneAt ?? '');
    try { await api(`/api/orders/${order.id}`, { action: 'done' }); } catch (e) { setTapped(null); onError((e as Error).message); }
  };
  const bag = (c: string) => lines.filter((l) => l.compartment_id === c);

  return (
    <div className="cp-screen cp-track">
      {onBack
        ? <div className="cp-brandrow"><button className="cp-round" aria-label="Back to my orders" onClick={onBack}><Icon d={BACK} /></button><Brand /></div>
        : <Brand />}
      <header className="cp-trackhead">
        <Floor d={d} robot={robot} />
        <div>
          <h1 className="headline">{headlineOf(d, shops, asked, checking)}</h1>
          <p>Order {order.id}</p>
        </div>
      </header>

      <ol className="cp-steps" aria-label="Delivery progress">
        {STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>{s}</li>)}
      </ol>

      {order.status === 'at_door' && !d.unlocked && <RobotCalling orderId={order.id} deadline={d.code_deadline} />}

      {order.status === 'at_door' && d.unlocked && !checking && !asked && (
        <div className="door-card">
          <p>Compartment{compartments.length > 1 ? 's' : ''} {compartments.map((c) => c.id).join(' and ')} {compartments.length > 1 ? 'are' : 'is'} open.</p>
          <ul className="bag-list">
            {compartments.map((c) => (
              <li key={c.id}>
                <span className="comp-tag">{c.id}</span>
                <span className="cp-bagthumbs">{bag(c.id).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 100)} alt="" />)}</span>
                <span>{bag(c.id).map((l) => `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}`).join(', ')}<small>{shopOf(c.id)}</small></span>
              </li>
            ))}
          </ul>
          <p className="cp-soft">Take what you want. Anything you leave goes back to the shop and isn’t charged.</p>
          <button className="cp-primary" onClick={tapDone}>I’ve taken my order</button>
        </div>
      )}

      {asked && (
        <div className="door-card">
          <p>{order.customer_message}</p>
          <button className="cp-primary" onClick={tapDone}>Done</button>
        </div>
      )}

      {step === 4 && (
        <div className="receipt">
          {order.customer_message && <p className="receipt-msg">{order.customer_message}</p>}
          <ul className="bag-list">
            {compartments.map((c) => {
              // What the handoff charged, even if a shop payout later failed: that's ops' problem, not the customer's.
              const charged = order.captured_cents > 0 && !!decision?.charge_compartments.includes(c.id);
              const kept = order.captured_cents > 0 && !charged && !!decision?.kept?.[c.id];
              return (
                <li key={c.id}>
                  <span className="cp-bagthumbs">{bag(c.id).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 100)} alt="" />)}</span>
                  <span>{bag(c.id).map((l) => l.name).join(', ')}</span>
                  <em className={charged ? 'ok' : ''}>{charged ? 'taken' : kept ? 'final sale, charged' : 'returned to shop'}</em>
                </li>
              );
            })}
          </ul>
          <div className="receipt-rows">
            <div className="receipt-row"><span>Held</span><span>{$(sum('held'))}</span></div>
            <div className="receipt-row"><span>Released back to you</span><span>{$(sum('voided'))}</span></div>
            <div className="receipt-row total"><span>Charged</span><strong>{$(sum('captured'))}</strong></div>
          </div>
          <button className="cp-secondary" onClick={onNew}>Order again</button>
        </div>
      )}
      {step < 4 && order.status !== 'at_door' && (
        <p className="cp-hold">{`${$(order.total_cents)} held by PayPal. Nothing is charged until you take your order.`}</p>
      )}
    </div>
  );
}

// The robot at the gate "calls" the customer; the code that opens it is only on this phone.
function RobotCalling({ orderId, deadline }: { orderId: string; deadline?: string | null }) {
  const code = readCodes()[orderId];
  return (
    <div className="door-card cp-calling" role="alert">
      <div className="cp-ring" aria-hidden="true"><Icon d={PHONE} size={22} stroke="#fff" /></div>
      <p><b>LiftDrop robot is calling</b><br />It’s outside your security gate with the compartments locked.</p>
      {deadline && <Countdown until={Date.parse(deadline)} bar label="The robot waits" />}
      {code ? <>
        <p className="cp-soft">Type this code on the robot’s screen to open it:</p>
        <p className="cp-code" aria-label={`Code ${code.split('').join(' ')}`}>{code.split('').map((c, i) => <span key={i}>{c}</span>)}</p>
      </> : <p className="cp-soft">Open LiftDrop on the phone you ordered with to see your code.</p>}
    </div>
  );
}

// ---------- my orders ----------

function MyOrders({ ids, shops, onOpen }: { ids: string[]; shops: Shop[]; onOpen: (id: string) => void }) {
  const [orders, setOrders] = useState<Detail[] | null>(null);
  useEffect(() => {
    // ponytail: one request per order (at most 20); a list endpoint when there are accounts.
    Promise.all(ids.map((id) => api<Detail>(`/api/orders/${id}`).catch(() => null)))
      .then((ds) => setOrders(ds.filter((d): d is Detail => !!d)));
  }, [ids]);
  return (
    <div className="cp-screen">
      <div className="cp-navrow cp-orders-head">
        <span className="cp-round-spacer" />
        <h1 className="cp-title">My orders</h1>
        <span className="cp-round-spacer" />
      </div>
      {!orders ? <p className="cp-soft">Loading your orders…</p>
        : !orders.length ? <p className="cp-empty">No orders yet. Your deliveries show up here.</p>
        : <ul className="cp-orders">
          {orders.map((d) => {
            const o = d.order;
            const charged = o.captured_cents;
            const settled = !['created', 'held', 'collecting', 'en_route', 'at_door'].includes(o.status);
            return (
              <li key={o.id}>
                <button onClick={() => onOpen(o.id)}>
                  <span className="cp-bagthumbs">{d.lines.slice(0, 3).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 100)} alt="" />)}</span>
                  <span className="cp-orders-main">
                    <b>{headlineOf(d, shops)}</b>
                    <small>{d.lines.map((l) => `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}`).join(', ')}</small>
                    <small>{new Date(o.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · Level {o.location.startsWith('L20') ? 20 : 23}</small>
                  </span>
                  <span className="cp-orders-amt">{settled ? $(charged) : $(o.total_cents)}<small>{settled ? 'charged' : 'held'}</small></span>
                </button>
              </li>
            );
          })}
        </ul>}
    </div>
  );
}
