'use client';

// A nudge for a demo that's waiting on a person: after a few seconds with nothing happening, a
// pulsing frame, a pointer and a short tip land on what to tap (Loaded at a shop, the gate code,
// the bags at the door, Taken back on the way home). Same look as the guided tour, but on its own:
// it shows whether or not the tour is on, and steps aside while the tour's bubble is up.

import { useEffect, useState } from 'react';

export type NudgeTip = { key: string; el: string; say: string };
type Box = { x: number; y: number; w: number; h: number };

const DELAY_MS = 8000;

export default function Nudge({ tip }: { tip: NudgeTip | null }) {
  const [shown, setShown] = useState<string | null>(null); // the tip key whose wait has run out
  const [closed, setClosed] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  // The clock restarts whenever the robot waits on something new.
  useEffect(() => {
    setShown(null);
    if (!tip) return;
    const t = window.setTimeout(() => setShown(tip.key), DELAY_MS);
    return () => clearTimeout(t);
  }, [tip?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = !!tip && shown === tip.key && closed !== tip.key;

  // Follow the target (panels move, the view can switch tabs and hide it).
  useEffect(() => {
    if (!live) return setBox(null);
    let raf = 0;
    const tick = () => {
      const el = [...document.querySelectorAll(tip!.el)].find((e) => e.getClientRects().length > 0);
      const r = el && !document.querySelector('.tour-bubble:not(.nudge)') ? el.getBoundingClientRect() : null;
      setBox((b) => !r || r.width === 0 ? null
        : b && Math.abs(b.x - r.x) < 1 && Math.abs(b.y - r.y) < 1 && Math.abs(b.w - r.width) < 1 && Math.abs(b.h - r.height) < 1 ? b
        : { x: r.x, y: r.y, w: r.width, h: r.height });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, tip?.el]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!live || !box) return null;
  const W = Math.min(260, innerWidth - 32), GAP = 16;
  // Beside the target if there's room, else below it, else above it.
  const right = box.x + box.w + GAP + W <= innerWidth - 16;
  const left = right ? box.x + box.w + GAP : Math.max(16, Math.min(box.x, innerWidth - W - 16));
  const top = right ? Math.max(16, Math.min(box.y, innerHeight - 160)) : box.y + box.h + GAP + 120 < innerHeight ? box.y + box.h + GAP : Math.max(16, box.y - 140);

  return (
    <>
      <span className="tour-ring" style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }} aria-hidden="true" />
      <svg className="tour-cursor" style={{ transform: `translate(${box.x + Math.min(box.w * 0.6, box.w - 8)}px, ${box.y + box.h * 0.6}px)` }} width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
        <path d="M2 2 L2 24 L8 18.5 L12.5 28 L16.5 26 L12 16.8 L20 16.5 Z" fill="var(--cp-coral)" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <div className="tour-bubble nudge" role="status" style={{ left, top, width: W }}>
        <span className="tour-n">Waiting on you</span>
        <button className="tour-x" aria-label="Hide this tip" onClick={() => setClosed(tip!.key)}>×</button>
        <p>{tip!.say}</p>
      </div>
    </>
  );
}
