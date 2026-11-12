'use client';

// PayPal sandbox buyer logins under the phone, so testers can copy them into the PayPal window.
// Only in sandbox mode, and only when SANDBOX_BUYERS is set. The panel is a native popover: it
// sits in the browser's top layer, so it stays usable above the overlay PayPal puts over the page
// while its window is open (that overlay uses the maximum z-index, so z-index alone can't win).

import { useEffect, useRef, useState } from 'react';

type Buyer = { email: string; password: string };

export default function TestLogins() {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [copied, setCopied] = useState('');
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then((c) => setBuyers(c.buyers ?? [])).catch(() => {});
  }, []);
  if (!buyers.length) return null;

  const show = (on: boolean) => {
    try { if (on) pop.current?.showPopover(); else pop.current?.hidePopover(); } catch { /* already in that state */ }
    setOpen(on);
  };
  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied((k) => (k === key ? '' : k)), 1500); }).catch(() => {});
  };
  const field = (label: string, value: string, key: string) => (
    <button key={key} className="tl-field" onClick={() => copy(value, key)} aria-label={`Copy ${label.toLowerCase()} ${value}`}>
      <span>{label}</span><code>{value}</code><em>{copied === key ? 'Copied' : 'Copy'}</em>
    </button>
  );
  // Accounts that share a password show it once.
  const groups = [...new Set(buyers.map((b) => b.password))].map((pw) => ({ pw, emails: buyers.filter((b) => b.password === pw).map((b) => b.email) }));

  return (
    <>
      <button className="tl-toggle" aria-expanded={open} onClick={() => show(!open)}>PayPal sandbox logins</button>
      <div ref={pop} popover="manual" className="tl-pop" aria-label="PayPal sandbox logins">
        <button className="tl-x" aria-label="Close" onClick={() => show(false)}>×</button>
        <p>Log in to the PayPal window with any of these. Test money only.</p>
        {groups.map((g, i) => (
          <div key={g.pw} className="tl-acct">
            {g.emails.map((e, j) => field('Email', e, `e${i}-${j}`))}
            {field(g.emails.length > 1 ? 'Password (all)' : 'Password', g.pw, `p${i}`)}
          </div>
        ))}
      </div>
    </>
  );
}
