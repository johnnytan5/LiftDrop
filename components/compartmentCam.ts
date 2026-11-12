// The robot's compartment cameras. The tower view draws bags as flat boxes, and SAM 3.1 finds
// nothing in that, so each photo is rendered from a small scene of its own: the compartment's
// liner and, for every dish still in it, a real-size model of the dish as packed (cup, bowl,
// croissant...). Whether a dish is in the compartment comes from the physics (where its bag is),
// never from the scale. Built like MuseConcierge's components/items.ts.
import * as THREE from 'three';
import { PACK, type Pack } from '../lib/vision.ts';

export const FRAME = { w: 640, h: 480 };
const INNER = { w: 0.26, d: 0.24, h: 0.2 }; // compartment interior, m

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
// Solid of revolution around z from [radius, height] points.
const lathe = (pts: [number, number][], seg = 40) => new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), seg).rotateX(Math.PI / 2);

// Seeded, so every photo of the same dish looks the same.
function rng(seed: number) {
  return (a: number, b: number) => { seed = (seed * 16807) % 2147483647; return a + ((seed - 1) / 2147483646) * (b - a); };
}

function cup(kind: 'iced_cup' | 'hot_cup' | 'fruit_cup'): THREE.Group {
  const g = new THREE.Group();
  const wall: [number, number][] = [[0, 0], [0.03, 0], [0.042, 0.12], [0.044, 0.122]]; // open top: the lid, if any, is its own mesh
  if (kind === 'hot_cup') {
    g.add(mesh(lathe(wall), std({ color: '#f4f1ea', roughness: 0.6 })));
    g.add(mesh(lathe([[0.0345, 0.03], [0.0395, 0.085], [0.0405, 0.085], [0.0355, 0.03]]), std({ color: '#8a5a33', roughness: 0.9 })));
    g.add(mesh(lathe([[0, 0.12], [0.045, 0.12], [0.045, 0.13], [0.03, 0.138], [0, 0.138]]), std({ color: '#2b2b2b', roughness: 0.5 })));
    return g;
  }
  if (kind === 'fruit_cup') {
    // Paper cup, fruit heaped above the rim.
    g.add(mesh(lathe(wall), std({ color: '#f6efe2', roughness: 0.6, side: THREE.DoubleSide })));
    g.add(mesh(lathe([[0.0345, 0.035], [0.0395, 0.09], [0.0405, 0.09], [0.0355, 0.035]]), std({ color: '#2e9e5b', roughness: 0.8 })));
    const r = rng(11);
    const fruit = ['#d7263d', '#f49d37', '#7fb800', '#ffd23f', '#6a3d9a'];
    for (let i = 0; i < 22; i++) g.add(mesh(new THREE.BoxGeometry(0.016, 0.016, 0.016).rotateZ(r(0, 3)), std({ color: fruit[i % fruit.length], roughness: 0.4 }), r(-0.028, 0.028), r(-0.028, 0.028), r(0.112, 0.14)));
    return g;
  }
  g.add(mesh(lathe(wall), std({ color: '#ffffff', roughness: 0.1, transparent: true, opacity: 0.35 })));
  if (kind === 'iced_cup') {
    g.add(mesh(lathe([[0, 0.004], [0.029, 0.004], [0.036, 0.06], [0, 0.06]]), std({ color: '#6b4226', roughness: 0.3 })));
    g.add(mesh(lathe([[0, 0.06], [0.036, 0.06], [0.04, 0.105], [0, 0.105]]), std({ color: '#d9bc98', roughness: 0.4 })));
    const r = rng(3);
    for (let i = 0; i < 6; i++) g.add(mesh(new THREE.BoxGeometry(0.018, 0.018, 0.018), std({ color: '#e8f4f8', transparent: true, opacity: 0.7 }), r(-0.02, 0.02), r(-0.02, 0.02), r(0.07, 0.1)));
    g.add(mesh(new THREE.SphereGeometry(0.044, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), std({ color: '#ffffff', transparent: true, opacity: 0.3 }), 0, 0, 0.122));
    g.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2).rotateX(Math.PI / 2), std({ color: '#2e9e5b' }), 0.01, 0, 0.12));
  }
  return g;
}

function bowl(kind: 'soup_bowl'): THREE.Group {
  const g = new THREE.Group();
  const r = rng(kind === 'soup_bowl' ? 5 : 9);
  const shell = mesh(lathe([[0, 0], [0.04, 0], [0.065, 0.055], [0.068, 0.058]]), std({ color: kind === 'soup_bowl' ? '#f7f3ec' : '#b98a55', roughness: 0.5, side: THREE.DoubleSide }));
  g.add(shell);
  if (kind === 'soup_bowl') {
    g.add(mesh(new THREE.CircleGeometry(0.062, 40), std({ color: '#c98b2f', roughness: 0.2 }), 0, 0, 0.05));
    for (let i = 0; i < 18; i++) {
      const t = new THREE.TorusGeometry(r(0.012, 0.03), 0.0025, 6, 24, r(2, 5));
      const n = mesh(t, std({ color: '#f1d98a', roughness: 0.6 }), r(-0.03, 0.03), r(-0.03, 0.03), 0.052);
      n.rotation.z = r(0, 6);
      g.add(n);
    }
    const egg = mesh(new THREE.SphereGeometry(0.018, 20, 12).scale(1, 1.3, 0.5), std({ color: '#fbfaf5' }), 0.022, 0.01, 0.056);
    g.add(egg, mesh(new THREE.CircleGeometry(0.009, 20), std({ color: '#f2a516' }), 0.022, 0.01, 0.0652));
    for (let i = 0; i < 12; i++) g.add(mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.006), std({ color: '#3e9b3a' }), r(-0.04, 0.04), r(-0.04, 0.04), 0.054));
  } else {
    const greens = ['#3e8e2a', '#5fae3b', '#8cc95a', '#2f6e20'];
    for (let i = 0; i < 34; i++) g.add(mesh(new THREE.SphereGeometry(r(0.012, 0.02), 10, 8).scale(1, 1, 0.45), std({ color: greens[i % 4], roughness: 0.7 }), r(-0.045, 0.045), r(-0.045, 0.045), r(0.035, 0.062)));
    for (let i = 0; i < 7; i++) g.add(mesh(new THREE.BoxGeometry(0.013, 0.013, 0.01), std({ color: '#e9d2a6' }), r(-0.035, 0.035), r(-0.035, 0.035), r(0.055, 0.065)));
  }
  return g;
}

function croissant(): THREE.Group {
  const g = new THREE.Group();
  const dough = std({ color: '#c98a3c', roughness: 0.55 });
  // Crescent: a torus arc, fattest in the middle, tapering to the tips.
  for (let i = 0; i < 7; i++) {
    const a = -1.2 + (i * 2.4) / 6;
    const fat = 0.022 * (1 - 0.55 * Math.abs(a) / 1.2);
    const s = mesh(new THREE.SphereGeometry(fat, 18, 12).scale(1.25, 1, 0.8), i % 2 ? dough : std({ color: '#b5732e', roughness: 0.6 }), Math.sin(a) * 0.045, -Math.cos(a) * 0.045 + 0.03, fat * 0.8);
    s.rotation.z = a;
    g.add(s);
  }
  return g;
}

function pastry(): THREE.Group {
  // Pain au chocolat: a rolled, laminated pastry, glossy on top, chocolate showing at the ends.
  const g = new THREE.Group();
  const shades = ['#d08a3a', '#c07a2e', '#dc9a4a'];
  for (let i = 0; i < 3; i++) {
    const layer = mesh(new THREE.CapsuleGeometry(0.024 - i * 0.004, 0.07, 6, 18).rotateZ(Math.PI / 2).scale(1, 1, 0.75), std({ color: shades[i], roughness: 0.35 + i * 0.1 }), 0, 0, 0.018 + i * 0.004);
    g.add(layer);
  }
  for (const x of [-0.05, 0.05]) for (const y of [-0.007, 0.007]) g.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 12).rotateZ(Math.PI / 2), std({ color: '#3b2314', roughness: 0.3 }), x, y, 0.02));
  return g;
}

/** An open takeaway box: kraft for dumplings and salad, white card for the bakery. */
function tray(color: string, fill: (g: THREE.Group) => void): THREE.Group {
  const g = new THREE.Group();
  const card = std({ color, roughness: 0.9 });
  g.add(mesh(new THREE.BoxGeometry(0.13, 0.09, 0.004), card, 0, 0, 0.002));
  for (const [x, y, w, d] of [[0, 0.045, 0.13, 0.004], [0, -0.045, 0.13, 0.004], [0.065, 0, 0.004, 0.09], [-0.065, 0, 0.004, 0.09]]) g.add(mesh(new THREE.BoxGeometry(w, d, 0.035), card, x, y, 0.0175));
  fill(g);
  return g;
}

const dumplingBox = () => tray('#b98a55', (g) => {
  for (let i = 0; i < 6; i++) {
    const x = -0.04 + (i % 3) * 0.04, y = i < 3 ? -0.02 : 0.02;
    g.add(mesh(new THREE.SphereGeometry(0.017, 18, 12).scale(1.2, 0.9, 0.75), std({ color: '#f3ead8', roughness: 0.5 }), x, y, 0.014));
    g.add(mesh(new THREE.TorusGeometry(0.012, 0.002, 6, 16, Math.PI).rotateX(Math.PI / 2), std({ color: '#e6d6b8' }), x, y, 0.024));
  }
});

const saladBox = () => tray('#b98a55', (g) => {
  const r = rng(9);
  const greens = ['#3e8e2a', '#5fae3b', '#8cc95a', '#2f6e20'];
  for (let i = 0; i < 40; i++) g.add(mesh(new THREE.SphereGeometry(r(0.01, 0.017), 10, 8).scale(1.3, 1, 0.4), std({ color: greens[i % 4], roughness: 0.7 }), r(-0.055, 0.055), r(-0.035, 0.035), r(0.012, 0.03)));
  for (let i = 0; i < 8; i++) g.add(mesh(new THREE.BoxGeometry(0.014, 0.014, 0.01), std({ color: '#e9d2a6' }), r(-0.05, 0.05), r(-0.03, 0.03), 0.032));
});

const pastryBox = () => tray('#f5f3ef', (g) => g.add(pastry()));

const BUILD: Record<Pack, () => THREE.Group> = {
  iced_cup: () => cup('iced_cup'), hot_cup: () => cup('hot_cup'), fruit_cup: () => cup('fruit_cup'),
  soup_bowl: () => bowl('soup_bowl'), salad_box: saladBox,
  croissant, pastry_box: pastryBox, dumpling_box: dumplingBox,
};

function compartment(): THREE.Group {
  const g = new THREE.Group();
  const liner = std({ color: '#d9dbde', roughness: 0.85 });
  const { w, d, h } = INNER;
  g.add(mesh(new THREE.BoxGeometry(w, d, 0.01), liner, 0, 0, -0.005));
  g.add(mesh(new THREE.BoxGeometry(w, 0.01, h), liner, 0, d / 2, h / 2));
  g.add(mesh(new THREE.BoxGeometry(0.01, d, h), liner, -w / 2, 0, h / 2));
  g.add(mesh(new THREE.BoxGeometry(0.01, d, h), liner, w / 2, 0, h / 2));
  g.add(mesh(new THREE.BoxGeometry(w, d, 0.01), liner, 0, 0, h + 0.005));
  return g;
}

/** The dishes as packed, laid out left to right (a second row behind if there are many), origin
 *  at the compartment floor. The camera photographs this; the tower view draws it on the bag. */
export function dishGroup(dishes: string[]): THREE.Group {
  const g = new THREE.Group();
  const shown = dishes.filter((id) => PACK[id]).slice(0, 4);
  shown.forEach((id, i) => {
    const perRow = Math.min(shown.length, 2);
    const row = Math.floor(i / 2), col = i % 2;
    const d = BUILD[PACK[id]]();
    d.position.set(perRow === 1 ? 0 : col === 0 ? -0.06 : 0.06, row ? 0.06 : -0.01, 0);
    d.rotation.z = (i * 0.7) % 1.2;
    g.add(d);
  });
  return g;
}

/** Render what's in one compartment right now. dishes: item ids, one entry per unit. */
export function photograph(renderer: THREE.WebGLRenderer, dishes: string[]): string {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1c1c1c');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
  const lamp = new THREE.PointLight(0xfff4e0, 0.6, 0, 0);
  lamp.position.set(0, -0.05, INNER.h - 0.02);
  scene.add(lamp, compartment());
  scene.add(dishGroup(dishes));
  // Wide camera at the top front edge of the compartment (the door side), looking in.
  const cam = new THREE.PerspectiveCamera(78, FRAME.w / FRAME.h, 0.01, 2);
  cam.up.set(0, 0, 1);
  cam.position.set(0, -INNER.d / 2 - 0.02, INNER.h - 0.01);
  cam.lookAt(0, 0.02, 0.02);

  const target = new THREE.WebGLRenderTarget(FRAME.w, FRAME.h, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  const px = new Uint8Array(FRAME.w * FRAME.h * 4);
  renderer.readRenderTargetPixels(target, 0, 0, FRAME.w, FRAME.h, px);
  renderer.setRenderTarget(prev);
  target.dispose();
  scene.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });

  const c = document.createElement('canvas');
  c.width = FRAME.w; c.height = FRAME.h;
  const img = c.getContext('2d')!.createImageData(FRAME.w, FRAME.h);
  const row = FRAME.w * 4;
  for (let y = 0; y < FRAME.h; y++) img.data.set(px.subarray((FRAME.h - 1 - y) * row, (FRAME.h - y) * row), y * row); // GL rows are bottom-up
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.85);
}
