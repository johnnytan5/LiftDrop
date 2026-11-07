'use client';

// Shop counter tablet: bags to put in the robot, a "Loaded" button, and what the shop earned.
// "Loaded" only matters when the robot page has "Shops load instantly" off.

import { useCallback, useEffect, useState } from 'react';
import type { Compartment, Item, LedgerRow, Order, OrderItem, Shop } from '../../lib/db.ts';

type State = { shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[]; order_items: OrderItem[]; ledger: LedgerRow[] };
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function Vendor() {
  const [s, setS] = useState<State | null>(null);
  const [shop, setShop] = useState('bakery');
  const [err, setErr] = useState('');

  const refresh = useCallback(() => fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()).then(setS).catch(() => {}), []);
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('shop');
    if (q) setShop(q);
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!s) return <main className="vendor"><p className="muted">Loading…</p></main>;
  const me = s.shops.find((x) => x.id === shop) ?? s.shops[0];
  const mine = s.compartments.filter((c) => c.shop_id === me.id);
  const orderOf = (c: Compartment) => s.orders.find((o) => o.id === c.order_id)!;
  const toLoad = mine.filter((c) => !c.loaded && ['held', 'collecting'].includes(orderOf(c).status));
  const lines = (c: Compartment) => s.order_items.filter((l) => l.order_id === c.order_id && l.compartment_id === c.id)
    .map((l) => `${l.qty}× ${s.items.find((i) => i.id === l.item_id)?.name ?? l.item_id}`).join(', ');
  const rows = s.ledger.filter((l) => l.shop_id === me.id);
  const total = (k: string) => rows.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_cents, 0);
  const sales = [...new Set(rows.map((r) => r.order_id))];

  const loaded = async (c: Compartment) => {
    setErr('');
    const res = await fetch(`/api/orders/${c.order_id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'loaded', compartment: c.id }) });
    if (!res.ok) setErr((await res.json()).error);
    refresh();
  };

  return (
    <main className="vendor">
      <header className="vendor-head">
        <h1>{me.name}</h1>
        <nav aria-label="Shop">
          {s.shops.map((x) => <button key={x.id} aria-pressed={x.id === me.id} onClick={() => { setShop(x.id); history.replaceState(null, '', `?shop=${x.id}`); }}>{x.name}</button>)}
        </nav>
      </header>
      {err && <p className="app-error" role="alert">{err}</p>}

      <section>
        <h2>Bags for the robot</h2>
        {toLoad.length === 0 ? <p className="muted">Nothing to load. New orders appear here as soon as they’re paid.</p> : toLoad.map((c) => (
          <div key={`${c.order_id}${c.id}`} className="load-card">
            <span className="comp-tag">{c.id}</span>
            <div>
              <div className="item-name">{lines(c)}</div>
              <div className="muted small">Order {c.order_id} · {$(c.value_cents)}</div>
            </div>
            {c.vendor_loaded_at ? <span className="muted small">Robot is closing compartment {c.id}</span>
              : <button className="primary" onClick={() => loaded(c)}>Loaded into {c.id}</button>}
          </div>
        ))}
      </section>

      <section>
        <h2>Earnings</h2>
        <div className="earn">
          <div><span>Paid to you</span><b>{$(total('paid_out'))}</b></div>
          <div><span>On its way</span><b>{$(total('payout_pending') - total('paid_out'))}</b></div>
          <div><span>LiftDrop fee</span><b>{$(total('fee'))}</b></div>
        </div>
        {sales.length > 0 && (
          <table className="sales">
            <thead><tr><th>Order</th><th>Sold</th><th>Fee</th><th>You get</th><th>Status</th></tr></thead>
            <tbody>
              {sales.map((id) => {
                const r = rows.filter((x) => x.order_id === id);
                const fee = r.find((x) => x.kind === 'fee')?.amount_cents ?? 0;
                const net = r.find((x) => x.kind === 'payout_pending')?.amount_cents ?? 0;
                return <tr key={id}><td>{id}</td><td>{$(fee + net)}</td><td>{$(fee)}</td><td>{$(net)}</td><td>{r.some((x) => x.kind === 'paid_out') ? 'Paid' : 'Sending'}</td></tr>;
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">Items a customer leaves in the robot come back to your counter and aren’t charged.</p>
      </section>
    </main>
  );
}
