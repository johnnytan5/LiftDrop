'use client';

// Guided tour: a coral pointer glides to the next thing to tap and says why, over the real
// landing page and /demo. Steps move on when the app actually gets there (the basket opens,
// the robot reaches the gate), so clicking around never breaks it. Off unless TOUR=on;
// first-time visitors are asked once, and the corner switch turns it on or off any time.

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Where = 'home' | 'user' | 'vendor' | 'ops';
type Step = { at: Where; el: string; say: string; done?: () => boolean };

const has = (sel: string) => !!document.querySelector(sel);
const view = (): Where | null => {
  if (location.pathname === '/') return 'home';
  if (location.pathname !== '/demo') return null;
  const v = new URLSearchParams(location.search).get('view');
  return v === 'vendor' || v === 'ops' ? v : 'user';
};
const PILL: Record<Exclude<Where, 'home'>, string> = {
  user: '.demo-pill button:nth-of-type(1)', vendor: '.demo-pill button:nth-of-type(2)', ops: '.demo-pill button:nth-of-type(3)',
};

const STEPS: Step[] = [
  { at: 'home', el: '.lp-ctas .lp-btn', say: 'Start here. The live demo runs a whole order: the phone, the robot, the shop and PayPal.', done: () => location.pathname === '/demo' },
  { at: 'user', el: '.cp-shop', say: 'Pick one of the four shops in the lobby.', done: () => has('.cp-shophead') || has('.cp-cartbar') },
  { at: 'user', el: '.cp-plus', say: 'Add a dish. For the full demo, add one from a second shop too: each shop gets its own compartment.', done: () => has('.cp-cartbar') },
  { at: 'user', el: '.cp-cartbar', say: 'Open your basket when you’re ready.', done: () => has('.cp-paybar') },
  // Skipped when there are no sandbox logins to show (mock mode); moves on once the logins are opened.
  { at: 'user', el: '.tl-toggle', say: 'This demo runs on the PayPal sandbox, so no real money moves. Open the test buyer logins: you’ll sign in with one in the PayPal window next.', done: () => !has('.tl-toggle') || has('.tl-pop:popover-open') },
  { at: 'user', el: '.cp-paybar', say: 'Pay with PayPal, signing in with a sandbox login. This only holds the money. Nothing is charged until you take your order.', done: () => has('.cp-track') },
  { at: 'user', el: PILL.vendor, say: 'The robot is heading to the shop. Switch to Vendor to see the shop’s tablet.', done: () => view() === 'vendor' },
  { at: 'vendor', el: '.vd-section', say: 'The order lands on the shop’s tablet the moment you pay, with the robot slot to pack it into. Once you’ve collected, PayPal Payouts sends the shop its share.' },
  { at: 'vendor', el: PILL.user, say: 'Back to the customer.', done: () => view() === 'user' },
  { at: 'user', el: '.rs-glass', say: 'Now play the shop staff: when the robot stops at a counter, tap “Loaded” on its screen once the bag is in. With two shops it stops twice.', done: () => /Delivering to Level/.test(document.querySelector('.rs-glass')?.textContent ?? '') || has('.rs-code') || has('.receipt') },
  { at: 'user', el: '.lift-panel', say: 'The robot rides the lift up to your floor. Give it a moment.', done: () => has('.rs-code') || has('.door-card .cp-primary') || has('.receipt') },
  { at: 'user', el: '.rs-code', say: 'It’s at your security gate. Type the 4-digit code from the phone on the robot’s screen.', done: () => has('.door-card .cp-primary') || has('.receipt') },
  { at: 'user', el: '.mimic', say: 'The doors are open. Take what you want with Customer’s hands, leave the rest, then tap “I’ve taken my order”.', done: () => has('.receipt') },
  { at: 'user', el: '.receipt', say: 'PayPal captured only what you took and released the rest. Anything left behind rides back to its shop.' },
  { at: 'user', el: PILL.ops, say: 'Last stop: the ops console.', done: () => view() === 'ops' },
  { at: 'ops', el: '.op-head', say: 'Ops sees every robot and order. When the scale and camera disagree and the agent can’t decide, the order lands here.' },
];

type Saved = { on: boolean; step: number };
const KEY = 'ld-tour';
const load = (): Saved | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const save = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: tour just won't remember */ } };

type Box = { x: number; y: number; w: number; h: number };
type Pos = { left: number; top: number };
const EDGE = 16, GAP = 18;

// Where the bubble goes: beside, under or over the target, or in a free corner, whichever hides
// the fewest buttons, links and switches. It never sits on the target itself.
function place(b: Box, W: number, H: number): Pos {
  const vw = innerWidth, vh = innerHeight;
  const cx = Math.max(EDGE, Math.min(vw - W - EDGE, b.x + b.w / 2 - W / 2));
  const cy = Math.max(76, Math.min(vh - H - EDGE, b.y + b.h / 2 - H / 2));
  const options: [Pos, number][] = [ // position, penalty (prefer next to the target)
    [{ left: b.x + b.w + GAP, top: cy }, 0], [{ left: cx, top: b.y + b.h + GAP }, 1],
    [{ left: cx, top: b.y - H - GAP }, 2], [{ left: b.x - W - GAP, top: cy }, 3],
    [{ left: EDGE, top: vh - H - EDGE }, 3000], [{ left: vw - W - EDGE, top: 76 }, 3000],
  ];
  const rects = [...document.querySelectorAll('button, a[href], input, select, [role="switch"]')]
    .filter((e) => !e.closest('.tour-bubble, .tour-chip'))
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  rects.push(document.querySelector('.tour-chip')?.getBoundingClientRect() ?? new DOMRect());
  const overlap = (p: Pos, r: { x: number; y: number; width: number; height: number }) =>
    Math.max(0, Math.min(p.left + W, r.x + r.width) - Math.max(p.left, r.x)) * Math.max(0, Math.min(p.top + H, r.y + r.height) - Math.max(p.top, r.y));
  let best: Pos | null = null, score = Infinity;
  for (const [p, penalty] of options) {
    if (p.left < EDGE || p.left + W > vw - EDGE || p.top < EDGE || p.top + H > vh - EDGE) continue;
    if (overlap(p, { x: b.x - 8, y: b.y - 8, width: b.w + 16, height: b.h + 16 }) > 0) continue;
    const sc = rects.reduce((n, r) => n + overlap(p, r), penalty);
    if (sc < score) { best = p; score = sc; }
  }
  // Nothing fits beside a big target (phone width): the screen edge away from it.
  return best ?? { left: cx, top: b.y + b.h / 2 > vh / 2 ? 76 : vh - H - EDGE };
}

export default function Tour() {
  const path = usePathname();
  const [enabled, setEnabled] = useState(false); // the TOUR=on master switch
  const [s, setS] = useState<Saved | null>(null);
  const [asked, setAsked] = useState(true); // false = first visit, show the welcome card
  const [box, setBox] = useState<Box | null>(null);
  const [here, setHere] = useState<Where | null>(null);
  const scrolled = useRef(-1);
  const bub = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then((c) => setEnabled(!!c.tour)).catch(() => {});
    const saved = load();
    setS(saved ?? { on: false, step: 0 });
    setAsked(!!saved);
  }, []);
  const set = (n: Saved) => { setS(n); save(n); setAsked(true); };

  const running = enabled && !!s?.on && s.step < STEPS.length;
  const step = running ? STEPS[s!.step] : null;

  // Follow the target every frame (panes scroll, the robot's panels come and go), and move on
  // when the step's condition is met.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      const at = view();
      setHere((h) => (h === at ? h : at));
      const st = STEPS[s!.step];
      if (st.at === 'home' && at && at !== 'home') return set({ on: true, step: s!.step + 1 }); // came straight to /demo
      if (st.done?.()) return set({ on: true, step: s!.step + 1 });
      // Somewhere else in the demo: point at the pill that leads back.
      // On the landing page mid-tour (a saved step), the way back in is the live demo button.
      const sel = at === st.at || st.at === 'home' ? st.el : at === 'home' ? STEPS[0].el : PILL[st.at];
      const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0);
      if (el && scrolled.current !== s!.step && at === st.at) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); scrolled.current = s!.step; }
      const r = el?.getBoundingClientRect();
      setBox((b) => !r ? (b ? null : b)
        : b && Math.abs(b.x - r.x) < 1 && Math.abs(b.y - r.y) < 1 && Math.abs(b.w - r.width) < 1 && Math.abs(b.h - r.height) < 1 ? b
        : { x: r.x, y: r.y, w: r.width, h: r.height });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, s?.step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !s || (path !== '/' && path !== '/demo')) return null;

  const chip = (
    <label className="tour-chip">
      <input type="checkbox" role="switch" checked={running} onChange={(e) => set({ on: e.target.checked, step: e.target.checked && s.step >= STEPS.length ? 0 : s.step })} />
      <span className="tour-switch" aria-hidden="true" />Guided tour
    </label>
  );

  if (!asked) return (
    <div className="tour-welcome" role="dialog" aria-label="Guided tour">
      <button className="tour-x" aria-label="Close" onClick={() => set({ on: false, step: 0 })}>×</button>
      <b>New here?</b>
      <p>A pointer walks you through one order, from the phone to the robot to PayPal. About three minutes.</p>
      <div className="tour-row">
        <button className="tour-go" onClick={() => set({ on: true, step: 0 })}>Show me around</button>
        <button className="tour-skip" onClick={() => set({ on: false, step: 0 })}>No thanks</button>
      </div>
    </div>
  );

  if (!step) return chip;
  const away = here !== step.at && step.at !== 'home';
  const say = away && here === 'home' ? 'You’re partway through the tour. Open the live demo to carry on, or start over.'
    : away ? `Switch to ${step.at === 'user' ? 'User' : step.at === 'vendor' ? 'Vendor' : 'Ops'} to carry on.` : step.say;
  const last = s.step === STEPS.length - 1;
  const W = Math.min(290, innerWidth - 32);
  const at = box ? place(box, W, bub.current?.offsetHeight ?? 130) : { left: (innerWidth - W) / 2, top: innerHeight - 200 };

  return (
    <>
      {chip}
      {box && <>
        <span className="tour-ring" style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }} aria-hidden="true" />
        <svg className="tour-cursor" style={{ transform: `translate(${box.x + Math.min(box.w * 0.6, box.w - 8)}px, ${box.y + box.h * 0.6}px)` }} width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
          <path d="M2 2 L2 24 L8 18.5 L12.5 28 L16.5 26 L12 16.8 L20 16.5 Z" fill="var(--cp-coral)" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      </>}
      <div ref={bub} className="tour-bubble" role="status" style={{ ...at, width: W }}>
        <span className="tour-n">{s.step + 1} / {STEPS.length}</span>
        <button className="tour-x" aria-label="End the tour" onClick={() => set({ on: false, step: s.step })}>×</button>
        <p>{say}</p>
        {away && here === 'home' && <button className="tour-go" onClick={() => set({ on: true, step: 0 })}>Start over</button>}
        {!away && !step.done && <button className="tour-go" onClick={() => set({ on: !last, step: last ? STEPS.length : s.step + 1 })}>{last ? 'Finish' : 'Next'}</button>}
      </div>
    </>
  );
}
