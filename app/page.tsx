// Landing: the robot, one line on what it does, and the way into the live demo.

import Link from 'next/link';
import { Logo } from '../components/Brand.tsx';

const POINTS = [
  ['Pay only for what you take', 'PayPal holds the total. The robot’s scale and camera check what leaves the compartment, and only that is captured.'],
  ['Rides the lift to your floor', 'It collects from the lobby shops, takes the lift, and unlocks at your security gate with a 4-digit code.'],
  ['Shops paid the same minute', 'PayPal Payouts sends each shop its share as soon as the order settles.'],
] as const;

export default function Landing() {
  return (
    <main className="lp">
      <header className="lp-top">
        <span className="lp-brand"><Logo size={30} />LiftDrop</span>
        <Link href="/demo" className="lp-toplink">Open the demo</Link>
      </header>

      <section className="lp-hero">
        <div className="lp-copy">
          <p className="lp-eyebrow">Robot delivery for office towers</p>
          <h1>The lobby,<br />delivered.</h1>
          <p className="lp-lede">Order from the shops downstairs by app or by phone call. A robot brings it up the lift to your floor, and you pay only for what you take out.</p>
          <div className="lp-ctas">
            <Link href="/demo" className="lp-btn">Try the live demo<span aria-hidden="true">→</span></Link>
            <Link href="/demo?view=vendor" className="lp-btn ghost">Shop view</Link>
            <Link href="/demo?view=ops" className="lp-btn ghost">Ops view</Link>
          </div>
        </div>
        <figure className="lp-stage">
          <span className="lp-spot" aria-hidden="true" />
          <img src="/landing-robot.webp" width={1080} height={1350} alt="The LiftDrop delivery robot: a white robot with two blue compartment doors and a smiling face screen" />
          <figcaption>LD-01 · two locked compartments, a scale and a camera in each</figcaption>
        </figure>
      </section>

      <section className="lp-points" aria-label="How it works">
        {POINTS.map(([t, d], i) => (
          <div key={t} className="lp-point">
            <span className="lp-num">{String(i + 1).padStart(2, '0')}</span>
            <h2>{t}</h2>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <footer className="lp-foot">Built on PayPal Orders, Payments and Payouts · robot simulated in MuJoCo</footer>
    </main>
  );
}
