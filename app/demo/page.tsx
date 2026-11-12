'use client';

// The live demo, three views under one pill: the customer (phone + MuJoCo tower), the shop's
// tablet, and the ops console. All three stay mounted and only the active one is shown, so the
// sim keeps driving, the phone keeps its cart and order, and the tablet keeps its shop.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Logo } from '../../components/Brand.tsx';
import OrderApp, { type RobotLive } from '../../components/OrderApp.tsx';
import RobotStage, { floorOf } from '../../components/RobotStage.tsx';
import TestLogins from '../../components/TestLogins.tsx';
import Ops from '../ops/page.tsx';
import Vendor from '../vendor/page.tsx';

const VIEWS = [['user', 'User'], ['vendor', 'Vendor'], ['ops', 'Ops']] as const;
type View = (typeof VIEWS)[number][0];

export default function Demo() {
  const [robot, setRobot] = useState<RobotLive>(null);
  const [view, setView] = useState<View>('user');
  useEffect(() => {
    const v = new URLSearchParams(location.search).get('view');
    if (VIEWS.some(([id]) => id === v)) setView(v as View);
  }, []);
  // PayPal's checkout overlay covers the whole window; in the demo it belongs to the customer's
  // phone, so pin it to the phone screen (coral.css .pp-in-phone). /order on a real phone keeps it full.
  useEffect(() => {
    const root = document.documentElement;
    const fit = () => {
      const r = document.querySelector('.phone-frame > *')?.getBoundingClientRect();
      if (!r?.width) return;
      root.style.setProperty('--pp-x', `${r.x}px`); root.style.setProperty('--pp-y', `${r.y}px`);
      root.style.setProperty('--pp-w', `${r.width}px`); root.style.setProperty('--pp-h', `${r.height}px`);
    };
    const mo = new MutationObserver(() => { if (document.querySelector('body > .paypal-checkout-sandbox')) fit(); });
    mo.observe(document.body, { childList: true });
    root.classList.add('pp-in-phone');
    addEventListener('resize', fit);
    fit();
    return () => { mo.disconnect(); removeEventListener('resize', fit); root.classList.remove('pp-in-phone'); };
  }, []);
  const pick = (v: View) => {
    setView(v);
    const u = new URL(location.href);
    u.searchParams.set('view', v);
    history.replaceState(null, '', u);
  };
  const at = VIEWS.findIndex(([id]) => id === view);

  return (
    <div className="demo">
      <header className="demo-nav">
        <Link href="/" className="demo-home" aria-label="LiftDrop home"><Logo size={28} /><span>LiftDrop</span></Link>
        <nav className="demo-pill" aria-label="Demo view" style={{ '--at': at } as React.CSSProperties}>
          <span className="demo-pill-thumb" aria-hidden="true" />
          {VIEWS.map(([id, label]) => (
            <button key={id} aria-pressed={view === id} onClick={() => pick(id)}>{label}</button>
          ))}
        </nav>
        <span className="demo-live"><span className="cp-tabdot" aria-hidden="true" />Live</span>
      </header>

      <div className="demo-pane" hidden={view !== 'user'}>
        <main className="split">
          <section className="phone-side" aria-label="Customer's phone">
            <div className="phone-frame"><OrderApp robot={robot} /></div>
            <p className="side-note">Scan-to-order works too: open <a href="/order">/order</a> on any phone.</p>
            <TestLogins />
          </section>
          <section className="robot-side" aria-label="Delivery robot, simulated live in MuJoCo">
            <RobotStage onRobot={(s) => setRobot((r) => {
              const floor = floorOf(s);
              return r && r.floor === floor && r.phase === s.phase ? r : { floor, phase: s.phase };
            })} />
          </section>
        </main>
      </div>
      <div className="demo-pane demo-scroll" hidden={view !== 'vendor'}><Vendor /></div>
      <div className="demo-pane demo-scroll" hidden={view !== 'ops'}><Ops /></div>
    </div>
  );
}
