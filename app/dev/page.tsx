'use client';

// Fake-button console: drives the whole money lifecycle on mocks, standing in for the
// robot sim until it posts the same events. Polls /api/state once a second.

import { useCallback, useEffect, useState } from 'react';
import type { Compartment, Decision, Item, LedgerRow, Order, OrderItem, Shop } from '../../lib/db.ts';

type State = {
  shops: Shop[]; items: Item[]; orders: Order[]; compartments: Compartment[];
  order_items: OrderItem[]; ledger: LedgerRow[]; decisions: Decision[];
};

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const btn: React.CSSProperties = { padding: '6px 10px', marginRight: 6, marginBottom: 6, border: '1px solid #999', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 16 };

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
}

export default function Dev() {
  const [s, setS] = useState<State | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({ croissant: 1, 'iced-latte': 1 });
  const [err, setErr] = useState('');

  const refresh = useCallback(() => fetch('/api/state').then((r) => r.json()).then(setS), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = (fn: () => Promise<unknown>) => async () => {
    setErr('');
    try { await fn(); } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    refresh();
  };
  const ev = (order_id: string, e: Record<string, unknown>) => post('/api/events', { order_id, ...e });
  const seq = (order_id: string, es: Record<string, unknown>[]) => async () => { for (const e of es) await ev(order_id, e); };

  if (!s) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>LiftDrop · mock lifecycle</h1>
      {err && <p role="alert" style={{ color: '#b00020' }}>{err}</p>}

      <section style={card}>
        <h2 style={{ marginTop: 0 }}>New order (L23 pantry)</h2>
        {s.items.map((i) => (
          <label key={i.id} style={{ display: 'inline-block', marginRight: 16 }}>
            {i.name} {$(i.price_cents)}{' '}
            <input type="number" min={0} max={10} value={cart[i.id] ?? 0} style={{ width: 44 }}
              onChange={(e) => setCart({ ...cart, [i.id]: Number(e.target.value) })} />
          </label>
        ))}
        <div style={{ marginTop: 12 }}>
          <button style={btn} onClick={run(() => post('/api/orders', {
            location: 'L23-pantry',
            cart: Object.entries(cart).filter(([, q]) => q > 0).map(([item_id, qty]) => ({ item_id, qty })),
          }))}>Create order</button>
          <button style={btn} onClick={run(() => post('/api/reset', {}))}>Reset all</button>
        </div>
      </section>

      {s.orders.map((o) => {
        const comps = s.compartments.filter((c) => c.order_id === o.id);
        const ledger = s.ledger.filter((l) => l.order_id === o.id);
        const decisions = s.decisions.filter((d) => d.order_id === o.id);
        return (
          <section key={o.id} style={card}>
            <h2 style={{ marginTop: 0 }}>
              {o.id} · {$(o.total_cents)} · <code>{o.status}</code>
              {o.captured_cents > 0 && <> · charged {$(o.captured_cents)}</>}
            </h2>
            {o.customer_message && <p>Customer sees: <strong>{o.customer_message}</strong></p>}

            <div>
              <button style={btn} onClick={run(() => post('/api/authorize', { order_id: o.id }))}>1. Approve (mock PayPal)</button>
              {comps.map((c) => (
                <button key={c.id} style={btn} onClick={run(() => ev(o.id, { type: 'loaded', compartment: c.id }))}>
                  2. {c.shop_id} loads {c.id}
                </button>
              ))}
              <button style={btn} onClick={run(() => ev(o.id, { type: 'arrived', floor: 23 }))}>3. Arrive L23</button>
            </div>
            <div>
              {comps.map((c) => (
                <span key={c.id}>
                  <button style={btn} onClick={run(seq(o.id, [
                    { type: 'door_opened', compartment: c.id }, { type: 'weight', compartment: c.id, grams: 0 }, { type: 'door_closed', compartment: c.id },
                  ]))}>Take {c.id}</button>
                  <button style={btn} title="Weight drop doesn't match the items" onClick={run(seq(o.id, [
                    { type: 'door_opened', compartment: c.id }, { type: 'weight', compartment: c.id, grams: Math.round(c.expected_g / 2) }, { type: 'door_closed', compartment: c.id },
                  ]))}>Fault: half-weight {c.id}</button>
                </span>
              ))}
              <button style={btn} onClick={run(() => ev(o.id, { type: 'timeout' }))}>Customer walks away (timeout)</button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 14 }}>
              <thead><tr>{['Comp', 'Shop', 'Items', 'Value', 'Loaded', 'Door', 'Start g', 'End g'].map((h) => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>{h}</th>)}</tr></thead>
              <tbody>
                {comps.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td><td>{c.shop_id}</td>
                    <td>{s.order_items.filter((x) => x.order_id === o.id && x.compartment_id === c.id).map((x) => `${x.qty}× ${x.item_id}`).join(', ')}</td>
                    <td>{$(c.value_cents)}</td><td>{c.loaded ? 'yes' : '-'}</td><td>{c.door_opened ? 'opened' : '-'}</td>
                    <td>{c.start_g ?? '-'}</td><td>{c.end_g ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {ledger.length > 0 && (
              <p style={{ fontSize: 14 }}>
                Ledger: {ledger.map((l) => `${l.kind}${l.shop_id ? `(${l.shop_id})` : ''} ${$(l.amount_cents)}`).join(' · ')}
              </p>
            )}
            {decisions.map((d) => {
              const a = d.applied as { action: string; amount_cents: number; clamped: boolean };
              return (
                <p key={d.id} style={{ fontSize: 14, background: '#f2f5ff', padding: 8, borderRadius: 6 }}>
                  {d.source === 'code' ? 'Rules' : 'Agent'} ({d.source}): <strong>{a.action}</strong>{a.amount_cents ? ` ${$(a.amount_cents)}` : ''}
                  {a.clamped && ' (clamped by guardrail)'} · {d.reason}
                </p>
              );
            })}
          </section>
        );
      })}
    </main>
  );
}
