'use client';

// "Call your order": mic -> AssemblyAI streaming speech-to-text -> Muse Spark (tools on the
// basket) -> AssemblyAI text-to-speech. The basket fills on screen as the caller talks; payment
// is the real PayPal button, because only the caller can approve it.
// Voice pipeline adapted from MuseConcierge components/CallPanel.tsx.

import { useEffect, useRef, useState } from 'react';
import { Gate } from '../lib/voice/gate.ts';
import { openAsr } from '../lib/voice/asr.ts';
import { hush, speak } from '../lib/voice/tts.ts';
import { CallSession, type CallLog } from '../lib/call/session.ts';
import { itemPhoto } from '../lib/menu-art.ts';
import Pay from './Pay.tsx';
import { $, cartCount, cartLines, cartShops, cartTotal, headlineOf, type Cart, type Config, type Detail, type Menu } from './order-shared.ts';

const GREETING = 'LiftDrop order line. What can I get you from the lobby?';
type Line = { who: 'caller' | 'agent' | 'system'; text: string };

const svg = (paths: string[], size = 22, width = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths.map((d) => <path key={d} d={d} />)}</svg>
);
const MIC = ['M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v1a7 7 0 0 1-14 0v-1', 'M12 18v4'];
const MIC_OFF = [...MIC, 'm2 2 20 20'];
const HANG_UP = ['M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L9 10.9', 'm22 2-20 20'];
const BAG = ['M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z', 'M3 6h18', 'M16 10a4 4 0 0 1-8 0'];
const CHECK = ['M20 6 9 17l-5-5'];

export default function CallScreen({ menu, cart, setCart, config, detail, onPaid, onClose }: {
  menu: Menu; cart: Cart; setCart: (c: Cart) => void; config: Config | null; detail: Detail | null;
  onPaid: (orderId: string) => void; onClose: (next?: 'basket') => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState('');
  const [live, setLive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [secs, setSecs] = useState(0);
  const [checkout, setCheckout] = useState(false);
  const [approved, setApproved] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [payError, setPayError] = useState('');

  const cartRef = useRef(cart);
  cartRef.current = cart;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const session = useRef<CallSession | null>(null);
  const hangup = useRef<() => void>(() => {});
  const log = useRef<HTMLOListElement>(null);
  const add = (l: Line) => setLines((ls) => [...ls, l]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lines, partial]);
  useEffect(() => { if (!live) return; const t = setInterval(() => setSecs((s) => s + 1), 1000); return () => clearInterval(t); }, [live]);

  // Start the call when the screen opens; hang up when it closes.
  useEffect(() => {
    let stopped = false;
    let asr: { stop(): void } | null = null;
    let stream: MediaStream | null = null;
    const gate = new Gate();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      asr?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      speechSynthesis?.cancel();
      setLive(false);
      setPartial('');
    };
    hangup.current = stop;

    const s = new CallSession({
      items: menu.items, shops: menu.shops,
      getCart: () => cartRef.current,
      setCart: (c) => { cartRef.current = c; setCart(c); },
      checkout: () => setCheckout(true),
      status: () => {
        const d = detailRef.current;
        return d ? { order: d.order.id, status: d.order.status, now: headlineOf(d, menu.shops), held: $(d.order.total_cents) } : null;
      },
    }, {
      onSay: (t) => (stopped ? Promise.resolve() : speak(t, gate)),
      onEnd: () => { stop(); add({ who: 'system', text: 'Call ended.' }); setTimeout(() => onClose(), 1200); },
      onThinking: setThinking,
      onHush: hush,
      onLog: (e: CallLog) => {
        if (e.kind === 'caller') add({ who: 'caller', text: e.text });
        else if (e.kind === 'agent') add({ who: 'agent', text: e.text });
        else if (e.kind === 'error') add({ who: 'system', text: `The line had a problem: ${e.text}` });
      },
    });
    session.current = s;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (stopped) return;
        const keywords = [...menu.items.map((i) => i.name), ...menu.shops.map((x) => x.name), 'PayPal'];
        asr = await openAsr({
          stream, keywords, gate, muted: () => mutedRef.current,
          onPartial: setPartial,
          onFinal: (t) => { setPartial(''); void s.onCaller(t); },
          onError: (m) => add({ who: 'system', text: `Transcriber: ${m}` }),
        });
        if (stopped) return asr.stop();
      } catch (e) {
        add({ who: 'system', text: `No microphone (${e instanceof Error ? e.message : e}). Type your order instead.` });
        setTyping(true);
      }
      if (stopped) return;
      setLive(true);
      s.greet(GREETING);
    })();
    return stop;
    // The call lives as long as the screen; menu and setters are stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hangUp = (next?: 'basket') => { hangup.current(); session.current?.end(); onClose(next); };
  const send = () => { const t = text.trim(); if (!t) return; setText(''); void session.current?.onCaller(t); };
  const paid = (id: string) => {
    setApproved(true);
    onPaid(id);
    session.current?.finish('Approved. Your robot is on its way. Bye!');
  };

  const lineItems = cartLines(cart);
  const mm = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="cp-call">
      <header className="cp-call-head">
        <div className="cp-call-k">LiftDrop order line</div>
        <div className="cp-call-t">{live ? `On call · ${mm}` : 'Connecting…'}</div>
      </header>

      <div className={`cp-orb${thinking ? ' is-thinking' : ''}${partial ? ' is-hearing' : ''}`} aria-hidden="true">
        <span><span><span className="cp-bars"><i /><i /><i /><i /><i /></span></span></span>
      </div>
      <p className="cp-call-state" aria-live="polite">{!live ? 'Starting the call…' : thinking ? 'Thinking…' : muted ? 'Muted' : typing ? 'Type below' : 'Listening'}</p>

      <ol className="cp-bubbles" ref={log} aria-label="Call transcript">
        {lines.map((l, i) => <li key={i} className={l.who}>{l.text}</li>)}
        {partial && <li className="caller partial">{partial}</li>}
      </ol>

      {typing && (
        <form className="cp-type" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input aria-label="Type to the order line" value={text} onChange={(e) => setText(e.target.value)} placeholder="A noodle soup and an iced latte" autoComplete="off" />
          <button type="submit" disabled={!text.trim() || !live}>Send</button>
        </form>
      )}

      {cartCount(cart) > 0 && (
        <div className="cp-callcard">
          <div className="cp-callcard-top">
            <span className="cp-thumbs">{lineItems.slice(0, 4).map((l) => <img key={l.item_id} src={itemPhoto(l.item_id, 120)} alt="" />)}</span>
            <span className="cp-callcard-items">{lineItems.map((l) => `${l.qty > 1 ? `${l.qty}× ` : ''}${menu.items.find((i) => i.id === l.item_id)?.name}`).join(', ')}</span>
            <b>{$(cartTotal(menu, cart))}</b>
          </div>
          <div className="cp-callcard-pay">
            {approved ? <>
              <span className="cp-ok">{svg(CHECK, 11, 3)}</span><span className="cp-grow"><b>PayPal</b> · payment held</span><span className="cp-approved">Approved</span>
            </> : checkout ? (
              <Pay lines={lineItems} config={config} label="Approve in PayPal" className="cp-approve" onStarted={paid} onError={setPayError} />
            ) : (
              <span className="cp-soft">{cartShops(menu, cart).length} of 2 shops · say “that’s all” to check out</span>
            )}
          </div>
          {payError && <p className="cp-payerror" role="alert">{payError}</p>}
        </div>
      )}

      <div className="cp-controls">
        <button className="cp-ctl" aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>{svg(muted ? MIC_OFF : MIC)}</button>
        <button className="cp-ctl cp-hang" aria-label="Hang up" onClick={() => hangUp()}>{svg(HANG_UP, 24, 2)}</button>
        <button className="cp-ctl" aria-label="Open basket" onClick={() => hangUp('basket')}>{svg(BAG)}</button>
      </div>
      {!typing && <button className="cp-typelink" onClick={() => setTyping(true)}>Type instead</button>}
    </div>
  );
}
