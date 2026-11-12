'use client';

// The MuJoCo tower drawn with three.js. Physics runs in lib/sim/sim.worker.ts; this only turns
// geom poses into meshes. Adapted from Concierge's components/SimView.tsx: three-quarter orbit
// camera that follows the robot (drag to orbit, scroll to zoom), glass, and floating labels.

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Floor, SimEvent, Stop } from '../lib/sim/tower.ts';
import { dishGroup, photograph } from './compartmentCam.ts';

export type TowerStatus = {
  phase: string; time: number; x: number; y: number; z: number; yaw: number; floor: number; lift: number;
  grams: { A: number; B: number }; doors: { A: number; B: number }; inSlot: { A: boolean; B: boolean };
};
export type TowerHandle = {
  deliver: (stops: Stop[], opts?: { autoLoad?: boolean; doorTimeout?: number; awaitVerdict?: boolean; floor?: Floor; codeWaitMs?: number }) => void;
  take: (comp: 'A' | 'B', fraction?: number) => void;
  raise: (name: string) => void;
  speed: (x: number) => void;
  /** The compartment camera's photo now: the dishes are drawn only if the bag is in the compartment. */
  photo: (comp: 'A' | 'B', dishes: string[]) => string;
  /** Draw these dishes on the bag (the same models the camera photographs); [] shows a plain bag. */
  dishes: (comp: 'A' | 'B', dishes: string[]) => void;
};

const LABELS: [string, number, number, number][] = [
  ['Level G Café', 0.1, 2.85, 2.55],
  ['Crumb Bakery', -1.95, 2.85, 2.55],
  ['Noodle House', -4, 2.85, 2.55],
  ['Green Bowl', -6.05, 2.85, 2.55],
  ['Security', -1.8, -2.3, 1.9],
  ['Halden Tower · Lobby', -1, -4.6, 1.2],
  ['Lift', 4.5, 0, 8.1],
  ['L20 · Orbit Labs', 2.9, 1.5, 5.45],
  ['L23 · Halden Capital', 2.9, 1.5, 8.65],
];

function label(text: string, depthTest: boolean) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(15,20,28,0.78)';
  g.beginPath(); g.roundRect(8, 24, 496, 80, 40); g.fill();
  g.fillStyle = '#fff'; g.font = '600 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 66);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest }));
  s.scale.set(1.6, 0.4, 1);
  s.renderOrder = 10;
  return s;
}

export default function TowerView({ onReady, onStatus, onEvent, onDone, onError, onScene, style, maxPixelRatio = 1.5 }: {
  onReady?: (h: TowerHandle) => void;
  /** Raw three.js access, for the /cover page that frames a still for the slides. */
  onScene?: (s: { camera: THREE.PerspectiveCamera; controls: OrbitControls; scene: THREE.Scene; renderer: THREE.WebGLRenderer; labels: THREE.Sprite[]; meshes: (THREE.Mesh | null)[] }) => void;
  onStatus?: (s: TowerStatus) => void;
  onEvent?: (e: SimEvent) => void;
  onDone?: (r: { timedOut: boolean; leftovers: string[] }) => void;
  onError?: (message: string) => void;
  style?: React.CSSProperties;
  /** Cap on render resolution: 1.5 keeps Retina sharp at about half the GPU work (2x is 4x the
   *  pixels). /cover passes 2 for its 4K stills. */
  maxPixelRatio?: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cb = useRef({ onReady, onStatus, onEvent, onDone, onError, onScene });
  useEffect(() => { cb.current = { onReady, onStatus, onEvent, onDone, onError, onScene }; });

  useEffect(() => {
    const el = mount.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1b2633');
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-4, -6, 12);
    scene.add(sun);
    // Office-floor signs are depth-tested so they hide behind the slab above; lobby signs always show.
    const labels = LABELS.map(([text, x, y, z]) => { const s = label(text, z > 3.2); s.position.set(x, y, z); scene.add(s); return s; });

    // MuJoCo is z-up.
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    camera.up.set(0, 0, 1);
    camera.position.set(-4, -10, 8);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(1, -1, 1);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 2;
    controls.maxDistance = 25;

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const meshes: (THREE.Mesh | null)[] = [];
    let bagGeom: Record<string, number> = {};
    const setDishes = (comp: 'A' | 'B', dishes: string[]) => {
      const bag = meshes[bagGeom[comp]];
      if (!bag) return;
      for (const old of [...bag.children]) {
        bag.remove(old);
        old.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      }
      const g = dishGroup(dishes);
      g.position.z = -0.05; // bag geom is centred; dishes stand on its floor
      g.scale.setScalar(1.5); // ponytail: oversized so a dish reads at tower zoom; the camera keeps real size
      bag.add(g);
      (bag.material as THREE.Material).visible = !g.children.length; // the box only when there's nothing to show
    };
    let last: TowerStatus | null = null;
    const robot = new THREE.Vector3(1, -2, 0.5);

    let ready = false; // local, not the `loading` state: this closure lives for the component's life
    const worker = new Worker(new URL('../lib/sim/sim.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'error') {
        if (!ready) setError(msg.message);
        cb.current.onError?.(msg.message);
        setLoading(false);
        return;
      }
      if (msg.type === 'static') {
        for (let i = 0; i < msg.ngeom; i++) {
          const type = msg.geomType[i], s = msg.geomSize.subarray(i * 3, i * 3 + 3);
          const a = msg.rgba[i * 4 + 3];
          if (msg.geomGroup[i] >= 3 || a === 0) { meshes.push(null); continue; }
          let geo: THREE.BufferGeometry | null = null;
          if (type === 0) geo = new THREE.PlaneGeometry(s[0] > 0 ? 2 * s[0] : 20, s[1] > 0 ? 2 * s[1] : 20);
          else if (type === 2) geo = new THREE.SphereGeometry(s[0], 20, 14);
          else if (type === 3) geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 6, 14).rotateX(Math.PI / 2);
          else if (type === 5) geo = new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 24).rotateX(Math.PI / 2);
          else if (type === 6) geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
          if (!geo) { meshes.push(null); continue; }
          const color = new THREE.Color(msg.rgba[i * 4], msg.rgba[i * 4 + 1], msg.rgba[i * 4 + 2]);
          // Glass: no depth write, or panes hide whatever is behind them depending on draw order.
          const mat = new THREE.MeshLambertMaterial({ color, transparent: a < 1, opacity: a, depthWrite: a >= 1, side: a < 1 ? THREE.DoubleSide : THREE.FrontSide });
          // The lift car's floor is flush with the lobby plane: push the plane back in depth or they z-fight.
          if (type === 0) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.matrixAutoUpdate = false;
          if (a < 1) mesh.renderOrder = 1;
          scene.add(mesh);
          meshes.push(mesh);
        }
        bagGeom = msg.bagGeom ?? {};
        ready = true;
        setLoading(false);
        cb.current.onScene?.({ camera, controls, scene, renderer, labels, meshes });
        cb.current.onReady?.({
          deliver: (stops, opts = {}) => worker.postMessage({ type: 'deliver', stops, ...opts }),
          take: (comp, fraction) => worker.postMessage({ type: 'take', comp, fraction }),
          raise: (name) => worker.postMessage({ type: 'raise', name }),
          speed: (x) => worker.postMessage({ type: 'speed', x }),
          photo: (comp, dishes) => photograph(renderer, last?.inSlot[comp] ? dishes : []),
          dishes: setDishes,
        });
      } else if (msg.type === 'frame') {
        const { xpos, xmat } = msg;
        for (let i = 0; i < meshes.length; i++) {
          const mesh = meshes[i];
          if (!mesh) continue;
          const r = xmat.subarray(i * 9, i * 9 + 9);
          mesh.matrix.set(r[0], r[1], r[2], xpos[i * 3], r[3], r[4], r[5], xpos[i * 3 + 1], r[6], r[7], r[8], xpos[i * 3 + 2], 0, 0, 0, 1);
        }
        last = msg.status;
        robot.set(msg.status.x, msg.status.y, msg.status.z + 0.4);
        cb.current.onStatus?.(msg.status);
      } else if (msg.type === 'event') cb.current.onEvent?.(msg.event);
      else if (msg.type === 'done') cb.current.onDone?.(msg.result);
    };

    // Follow the robot: move target and camera by the same delta, so a user's orbit/zoom sticks.
    let raf = 0;
    const delta = new THREE.Vector3();
    const draw = () => {
      delta.copy(robot).sub(controls.target).multiplyScalar(0.06);
      controls.target.add(delta);
      camera.position.add(delta);
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      worker.terminate();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={mount} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 360, ...style }}>
      {(loading || error) && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d8d4d3', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14 }}>
          {error ? `Simulation failed to start: ${error}` : 'Loading MuJoCo…'}
        </div>
      )}
    </div>
  );
}
