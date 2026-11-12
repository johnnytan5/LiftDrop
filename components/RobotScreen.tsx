'use client';

// The touch screen on the robot's side, shown as a floating window over the tower. Shop staff
// tap "Loaded" here once the bag is in (not on their tablet), and at the gate the robot "calls"
// the customer and stays locked until they type the 4-digit code from their phone.

import { useEffect, useState } from 'react';
import Countdown from './Countdown.tsx';

export type ScreenMode =
  | { kind: 'status'; title: string; text: string }
  | { kind: 'load'; shop: string; comp: string; items: string[]; done: boolean }
  | { kind: 'return'; shop: string; comp: string; items: string[] }
  | { kind: 'code'; floor: number; until: number }
  | { kind: 'open'; comps: string[] };

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

export default function RobotScreen({ name, mode, onLoaded, onReturned, onCode, onDone }: {
  name: string; mode: ScreenMode;
  onLoaded: (comp: string) => void;
  onReturned: (comp: string) => void;
  /** Resolves with what the backend said; throws when the robot is locked out. */
  onCode: (code: string) => Promise<{ unlocked: boolean; tries_left: number }>;
  onDone: () => void;
}) {
  return (
    <section className="rs" aria-label={`Robot ${name} touch screen`}>
      <header className="rs-head"><span className="rs-dot" aria-hidden="true" />{name} · touch screen</header>
      <div className="rs-glass">
        {mode.kind === 'status' && <div className="rs-status"><b>{mode.title}</b><span>{mode.text}</span></div>}
        {mode.kind === 'load' && (
          <div className="rs-load">
            <span className="rs-k">{mode.shop}</span>
            <b>Put this order in compartment {mode.comp}</b>
            <ul>{mode.items.map((i) => <li key={i}>{i}</li>)}</ul>
            {mode.done ? <span className="rs-wait">Closing compartment {mode.comp}…</span>
              : <button className="rs-big" onClick={() => onLoaded(mode.comp)}>Loaded · close {mode.comp}</button>}
          </div>
        )}
        {mode.kind === 'return' && (
          <div className="rs-load">
            <span className="rs-k">{mode.shop} · returning</span>
            <b>Not collected. Please take it back from compartment {mode.comp}</b>
            <ul>{mode.items.map((i) => <li key={i}>{i}</li>)}</ul>
            <span className="rs-wait">The customer wasn’t charged for this.</span>
            <button className="rs-big" onClick={() => onReturned(mode.comp)}>Taken back · close {mode.comp}</button>
          </div>
        )}
        {mode.kind === 'code' && <Keypad floor={mode.floor} until={mode.until} onCode={onCode} />}
        {mode.kind === 'open' && (
          <div className="rs-status">
            <b>Compartment{mode.comps.length > 1 ? 's' : ''} {mode.comps.join(' and ')} open</b>
            <span>Take your order. Anything you leave goes back to the shop, not charged.</span>
            <button className="rs-big" onClick={onDone}>I’ve taken my order</button>
          </div>
        )}
      </div>
    </section>
  );
}

function Keypad({ floor, until, onCode }: { floor: number; until: number; onCode: (code: string) => Promise<{ unlocked: boolean; tries_left: number }> }) {
  const [digits, setDigits] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [shake, setShake] = useState(0);

  const submit = async (code: string) => {
    setBusy(true);
    try {
      const r = await onCode(code);
      if (!r.unlocked) { setMsg(`Wrong code · ${r.tries_left} ${r.tries_left === 1 ? 'try' : 'tries'} left`); setShake((n) => n + 1); setDigits(''); }
    } catch (e) {
      setLocked(true); setMsg((e as Error).message); setDigits('');
    } finally { setBusy(false); }
  };
  const press = (k: string) => {
    if (busy || locked) return;
    if (k === 'del') return setDigits((d) => d.slice(0, -1));
    if (k === 'ok') return digits.length === 4 ? void submit(digits) : undefined;
    const next = (digits + k).slice(0, 4);
    setDigits(next);
    if (next.length === 4) void submit(next);
  };
  // A real keyboard works too, for the demo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return (
    <div className="rs-code">
      <div className="rs-calling" aria-live="polite">
        <span className="rs-ring" aria-hidden="true">📞</span>
        <span><b>Calling the customer…</b><small>Level {floor} · compartments locked</small>{until > 0 && <small className="rs-left">Waiting <Countdown until={until} /> more</small>}</span>
      </div>
      <p className="rs-k">Enter the 4-digit code from your LiftDrop app</p>
      <div key={shake} className={`rs-dots${shake ? ' is-wrong' : ''}`} aria-label={`${digits.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => <span key={i} className={i < digits.length ? 'on' : ''} />)}
      </div>
      <p className={`rs-msg${locked ? ' bad' : ''}`} role="status">{busy ? 'Checking…' : msg}</p>
      <div className="rs-keys">
        {KEYS.map((k) => (
          <button key={k} disabled={locked || busy || (k === 'ok' && digits.length < 4)} aria-label={k === 'del' ? 'Delete digit' : k === 'ok' ? 'Enter code' : `Digit ${k}`} onClick={() => press(k)}>
            {k === 'del' ? '⌫' : k === 'ok' ? '✓' : k}
          </button>
        ))}
      </div>
    </div>
  );
}
