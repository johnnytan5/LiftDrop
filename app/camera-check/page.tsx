'use client';

// Bench for the compartment cameras: renders each dish as the robot's camera sees it, asks
// SAM 3.1 (via /api/vision) and draws what it found. Use it to pick prompts in lib/vision.ts.
import { useState } from 'react';
import * as THREE from 'three';
import { photograph, FRAME } from '../../components/compartmentCam.ts';
import type { CameraCheck } from '../../lib/vision.ts';

const CASES: string[][] = [
  ['iced-latte'], ['americano'], ['fruit-cup'], ['chicken-noodle'], ['caesar'], ['croissant'], ['pain-choc'], ['macarons'], ['dumplings'],
  ['croissant', 'croissant'], ['iced-latte', 'americano'], ['chicken-noodle', 'dumplings'], ['caesar', 'fruit-cup'],
];
type Row = { dishes: string[]; taken: boolean; image: string; result?: CameraCheck; error?: string };

export default function CameraCheck() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    // Each case twice: with the dishes in (SAM must find each) and after they're taken (it must find none).
    const out: Row[] = CASES.flatMap((dishes) => [false, true].map((taken) => ({ dishes, taken, image: photograph(renderer, taken ? [] : dishes) })));
    renderer.dispose();
    setRows(out);
    await Promise.all(out.map(async (r, i) => {
      const items = Object.entries(r.dishes.reduce<Record<string, number>>((a, d) => ({ ...a, [d]: (a[d] ?? 0) + 1 }), {})).map(([item_id, qty]) => ({ item_id, qty }));
      if (!items.length) return;
      try {
        const res = await fetch('/api/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: r.image, items }) });
        const j = await res.json();
        out[i] = { ...r, ...(res.ok ? { result: j } : { error: j.error }) };
      } catch (e) { out[i] = { ...r, error: String(e) }; }
      setRows([...out]);
    }));
    setBusy(false);
  };
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui', background: '#f4f4f4', minHeight: '100vh' }}>
      <h1 style={{ margin: '0 0 8px' }}>Compartment camera check</h1>
      <p style={{ margin: '0 0 16px', color: '#555' }}>Each dish as the robot photographs it, and what SAM 3.1 finds. Green box: found.</p>
      <button onClick={run} disabled={busy} style={{ padding: '10px 16px', fontSize: 15 }}>{busy ? 'Checking…' : 'Render and check'}</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
        {rows.map((r, i) => (
          <figure key={i} data-case={`${r.dishes.join('+') || 'empty'}${r.taken ? ' taken' : ''}`} style={{ margin: 0, background: '#fff', padding: 8, borderRadius: 8 }}>
            <div style={{ position: 'relative' }}>
              <img src={r.image} alt={`Compartment with ${r.dishes.join(', ') || 'nothing'}`} style={{ width: '100%', display: 'block' }} />
              {r.result && Object.entries(r.result.found).map(([k, b]) => b && (
                <span key={k} style={{ position: 'absolute', left: `${(b.x1 / b.w) * 100}%`, top: `${(b.y1 / b.h) * 100}%`, width: `${((b.x2 - b.x1) / b.w) * 100}%`, height: `${((b.y2 - b.y1) / b.h) * 100}%`, border: '2px solid #2e9e5b' }} />
              ))}
            </div>
            <figcaption className="verdict" style={{ fontSize: 13, marginTop: 6 }}>
              <b>{r.dishes.join(' + ') || 'empty'}{r.taken ? ' — taken' : ''}</b>{' '}
              {r.error ? `error: ${r.error}` : r.result ? Object.entries(r.result.found).map(([k, b]) => `${k}: ${b ? `found ${b.c.toFixed(2)}` : 'MISSING'}`).join(', ') + (r.result.failed.length ? ` failed: ${r.result.failed.join(',')}` : '') + ` (${r.result.ms} ms)` : r.dishes.length ? 'checking…' : 'nothing to find'}
            </figcaption>
          </figure>
        ))}
      </div>
      <p style={{ color: '#777', fontSize: 12 }}>Frames are {FRAME.w}×{FRAME.h}.</p>
    </main>
  );
}
