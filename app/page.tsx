'use client';

// Split screen for the demo: the customer's phone on the left, the live MuJoCo tower on the
// right. They share nothing but the backend, exactly as a real phone and robot would.

import { useState } from 'react';
import OrderApp, { type RobotLive } from '../components/OrderApp.tsx';
import RobotStage, { floorOf } from '../components/RobotStage.tsx';

export default function Home() {
  const [robot, setRobot] = useState<RobotLive>(null);
  return (
    <main className="split">
      <section className="phone-side" aria-label="Customer's phone">
        <div className="phone-frame"><OrderApp robot={robot} /></div>
        <p className="side-note">Scan-to-order works too: open <a href="/order">/order</a> on any phone. Shops use <a href="/vendor">/vendor</a>.</p>
      </section>
      <section className="robot-side" aria-label="Delivery robot, simulated live in MuJoCo">
        <RobotStage onRobot={(s) => setRobot((r) => {
          const floor = floorOf(s);
          return r && r.floor === floor && r.phase === s.phase ? r : { floor, phase: s.phase };
        })} />
      </section>
    </main>
  );
}
