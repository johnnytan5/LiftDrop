'use client';

// PayPal checkout. Sandbox: the real PayPal button; the popup approves, then our server
// authorizes (holds). Mock: one button that does the same against the mock.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Order } from '../lib/db.ts';
import { api, type Config } from './order-shared.ts';

type PayPalNS = { Buttons: (o: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void> } };
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

export default function Pay({ lines, config, label, className = 'cp-pay', onStarted, onError }: {
  lines: { item_id: string; qty: number }[]; config: Config | null; label: string; className?: string;
  onStarted: (id: string) => void; onError: (m: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const cb = useRef({ onStarted, onError }); // parent callbacks change identity; the PayPal button must not re-render
  cb.current = { onStarted, onError };
  const [busy, setBusy] = useState(false);

  const create = useCallback(() => api<Order>('/api/orders', { location: 'L23-pantry', cart: linesRef.current }), []);

  useEffect(() => {
    if (config?.mode !== 'sandbox' || !config.clientId || !box.current) return;
    let ours: string | null = null;
    let closed = false;
    const el = box.current;
    loadPayPal(config.clientId).then((paypal) => {
      if (closed) return;
      const b = paypal.Buttons({
        style: { layout: 'horizontal', shape: 'pill', label: 'pay', height: 48, tagline: false },
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
    <button className={className} disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const o = await create();
        await api('/api/authorize', { order_id: o.id });
        onStarted(o.id);
      } catch (e) { onError((e as Error).message); setBusy(false); }
    }}>{busy ? 'Holding payment…' : label}</button>
  );
}
