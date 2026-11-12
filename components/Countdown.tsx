'use client';

// Time left until `until` (epoch ms) as m:ss, ticking each second. With `bar`, a line that drains
// over the robot's gate wait (CODE_WAIT_S), for the phone's "robot is calling" card.

import { useEffect, useState } from 'react';
import { CODE_WAIT_S } from '../lib/sim/tower.ts';

export default function Countdown({ until, bar, label }: { until: number; bar?: boolean; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((until - now) / 1000));
  const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (!bar) return <span className="cd" role="timer">{text}</span>;
  return (
    <div className={`cd-card${left <= 60 ? ' low' : ''}`} role="timer" aria-label={`${label} ${Math.floor(left / 60)} minutes ${left % 60} seconds more`}>
      <div className="cd-row"><span>{label}</span><b>{text}</b></div>
      <span className="cd-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (left / CODE_WAIT_S) * 100)}%` }} /></span>
    </div>
  );
}
