// Set dressing for the /cover still only (the sim never sees any of this): people in the lobby,
// things on the counters, the robot's lit face and logo, and a lens blur that keeps the robot sharp.
import * as THREE from 'three';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

const lambert = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const add = (g: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
};
// three.js primitives are y-up; MuJoCo (and this scene) is z-up.
const zup = <T extends THREE.BufferGeometry>(g: T) => g.rotateX(Math.PI / 2);

// ---------- people ----------

export type Look = {
  shirt: string; pants: string; skin: string; hair: string; shoes: string;
  height?: number; build?: number; hairStyle?: 'short' | 'long' | 'bun' | 'cap';
  hold?: 'cup' | 'phone' | 'tote' | 'none'; staff?: boolean;
};

/** A stylised person (1.7 m by default) standing at (x, y) facing `facing` (radians, 0 = +x). */
export function person(x: number, y: number, facing: number, look: Look) {
  const g = new THREE.Group();
  const h = look.height ?? 1;
  const w = look.build ?? 1;
  const skin = lambert(look.skin), shirt = lambert(look.shirt), pants = lambert(look.pants), hair = lambert(look.hair), shoe = lambert(look.shoes);

  // Shoes, legs (slightly tapered), hips.
  for (const s of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.22, 0.085, 0.06), shoe, 0.04, s * 0.085 * w, 0.03); // long axis forward (+x)
    add(g, zup(new THREE.CylinderGeometry(0.062 * w, 0.05, 0.78, 12)), pants, 0, s * 0.085 * w, 0.46);
  }
  add(g, zup(new THREE.CylinderGeometry(0.15 * w, 0.14 * w, 0.14, 16)), pants, 0, 0, 0.86).scale.set(0.75, 1, 1);
  // Torso: wider at the shoulders, flattened front to back.
  const torso = add(g, zup(new THREE.CylinderGeometry(0.2 * w, 0.15 * w, 0.52, 18)), shirt, 0, 0, 1.17);
  torso.scale.set(0.62, 1, 1);
  add(g, new THREE.SphereGeometry(0.2 * w, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), shirt, 0, 0, 1.43).scale.set(0.62, 1, 0.45);
  if (look.staff) {
    const apron = add(g, new THREE.BoxGeometry(0.015, 0.26, 0.5), lambert('#e8684a'), 0.11, 0, 1.0);
    apron.rotation.y = -0.08;
  }
  // Arms hang from the shoulders, a little forward; a held item puts one forearm up.
  for (const s of [-1, 1]) {
    const holding = s === 1 && look.hold && look.hold !== 'none' && look.hold !== 'tote';
    const upper = new THREE.Group();
    upper.position.set(0, s * 0.215 * w, 1.4);
    upper.rotation.x = s * 0.03; // arms close to the body
    add(upper, zup(new THREE.CapsuleGeometry(0.048, 0.26, 4, 10)), shirt, 0, 0, -0.17);
    const fore = new THREE.Group();
    fore.position.set(0, 0, -0.33);
    fore.rotation.y = holding ? -1.25 : -0.12;
    add(fore, zup(new THREE.CapsuleGeometry(0.042, 0.22, 4, 10)), skin, 0, 0, -0.14);
    add(fore, new THREE.SphereGeometry(0.048, 10, 8), skin, 0, 0, -0.29);
    if (holding && look.hold === 'cup') {
      add(fore, zup(new THREE.CylinderGeometry(0.04, 0.032, 0.12, 14)), lambert('#f4efe6'), 0.02, 0, -0.33);
      add(fore, zup(new THREE.CylinderGeometry(0.041, 0.041, 0.04, 14)), lambert('#7a4b2a'), 0.02, 0, -0.27);
    }
    if (holding && look.hold === 'phone') add(fore, new THREE.BoxGeometry(0.012, 0.075, 0.15), lambert('#1d1f24'), 0.03, 0, -0.33);
    if (s === -1 && look.hold === 'tote') {
      const bag = add(fore, new THREE.BoxGeometry(0.08, 0.3, 0.32), lambert('#d9c9a8'), 0, 0, -0.42);
      bag.rotation.x = 0.05;
    }
    upper.add(fore);
    g.add(upper);
  }
  // Neck, head (a touch taller than wide), ears, hair.
  add(g, zup(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 12)), skin, 0, 0, 1.49);
  add(g, new THREE.SphereGeometry(0.105, 22, 16), skin, 0, 0, 1.6).scale.set(1, 0.92, 1.12);
  for (const s of [-1, 1]) add(g, new THREE.SphereGeometry(0.022, 8, 6), skin, -0.005, s * 0.098, 1.6);
  const style = look.hairStyle ?? 'short';
  if (style === 'cap') {
    add(g, new THREE.SphereGeometry(0.112, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.1).rotateX(Math.PI / 2), lambert(look.staff ? '#e8684a' : look.hair), 0, 0, 1.62);
    add(g, new THREE.BoxGeometry(0.1, 0.16, 0.012), lambert(look.staff ? '#e8684a' : look.hair), 0.12, 0, 1.655);
  } else {
    add(g, new THREE.SphereGeometry(0.113, 22, 12, 0, Math.PI * 2, 0, Math.PI / 1.85).rotateX(Math.PI / 2), hair, -0.008, 0, 1.6).scale.set(1, 0.95, 1.15);
    if (style === 'long') add(g, new THREE.BoxGeometry(0.07, 0.2, 0.26), hair, -0.075, 0, 1.5).scale.set(1, 1, 1);
    if (style === 'bun') add(g, new THREE.SphereGeometry(0.055, 12, 10), hair, -0.1, 0, 1.72);
  }

  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
  g.position.set(x, y, 0);
  g.rotation.z = facing;
  g.scale.setScalar(h);
  return g;
}

const SKIN = ['#f1c27d', '#c68642', '#8d5524', '#e0ac69', '#ffdbac', '#a8714a'];
const HAIR = ['#2b1d14', '#4b3621', '#121212', '#8a5a33', '#d8b26e', '#3a2a20'];
const N = Math.PI / 2; // facing the counters (north)

// Customers at the windows, staff behind the counters, a few people crossing the lobby.
export const CROWD: [number, number, number, Look][] = [
  [0.45, 2.2, N, { shirt: '#3f6e8c', pants: '#2f3e46', skin: SKIN[0], hair: HAIR[1], shoes: '#efefef', hold: 'phone', hairStyle: 'short' }],
  [-0.4, 1.9, N + 0.35, { shirt: '#d9a441', pants: '#4a4e69', skin: SKIN[4], hair: HAIR[4], shoes: '#3b2f2f', hold: 'tote', hairStyle: 'long', height: 0.95, build: 0.9 }],
  [-1.55, 2.25, N - 0.1, { shirt: '#6a8f5e', pants: '#22333b', skin: SKIN[2], hair: HAIR[2], shoes: '#222', hairStyle: 'short', hold: 'cup', height: 1.03 }],
  [-2.45, 1.85, N + 0.2, { shirt: '#b5838d', pants: '#2b2d42', skin: SKIN[3], hair: HAIR[0], shoes: '#f5f5f5', hold: 'cup', hairStyle: 'bun', height: 0.96, build: 0.92 }],
  [-3.75, 2.2, N, { shirt: '#e9ecef', pants: '#495057', skin: SKIN[5], hair: HAIR[3], shoes: '#2d2d2d', hairStyle: 'cap' }],
  [-5.8, 2.1, N + 0.25, { shirt: '#5e548e', pants: '#3d405b', skin: SKIN[1], hair: HAIR[5], shoes: '#eee', hold: 'phone', hairStyle: 'long', height: 0.97 }],
  // Staff (facing the windows).
  [-0.2, 3.78, -N, { shirt: '#f8f8f8', pants: '#2b2b2b', skin: SKIN[3], hair: HAIR[0], shoes: '#222', staff: true, hairStyle: 'cap' }],
  [-2.25, 3.78, -N, { shirt: '#f8f8f8', pants: '#2b2b2b', skin: SKIN[1], hair: HAIR[2], shoes: '#222', staff: true, hairStyle: 'cap', height: 0.96 }],
  [-4.3, 3.78, -N, { shirt: '#f8f8f8', pants: '#2b2b2b', skin: SKIN[4], hair: HAIR[4], shoes: '#222', staff: true, hairStyle: 'cap' }],
  [-6.35, 3.78, -N, { shirt: '#f8f8f8', pants: '#2b2b2b', skin: SKIN[2], hair: HAIR[1], shoes: '#222', staff: true, hairStyle: 'cap', height: 1.02 }],
  // Passers-by.
  [-2.9, 0.9, Math.PI, { shirt: '#2a9d8f', pants: '#264653', skin: SKIN[0], hair: HAIR[3], shoes: '#fff', hold: 'cup', hairStyle: 'short', height: 1.02 }],
  [-3.45, 1.15, Math.PI + 0.5, { shirt: '#e76f51', pants: '#3d405b', skin: SKIN[2], hair: HAIR[2], shoes: '#222', hairStyle: 'long', hold: 'tote', height: 0.95, build: 0.9 }],
  [-5.2, -0.4, 0.3, { shirt: '#457b9d', pants: '#1d3557', skin: SKIN[4], hair: HAIR[1], shoes: '#333', hairStyle: 'short' }],
  [2.6, 1.6, N + 1, { shirt: '#f4a261', pants: '#2f3e46', skin: SKIN[5], hair: HAIR[0], shoes: '#eee', hold: 'phone', hairStyle: 'bun', height: 0.96, build: 0.92 }],
];

// ---------- counters ----------

const COUNTERS: [number, string, string][] = [ // x of each counter, menu-board accent, what's on it
  [-0.2, '#6b4f3a', 'coffee'], [-2.25, '#c8963e', 'bakery'], [-4.3, '#b23a48', 'noodles'], [-6.35, '#5b8c5a', 'greens'],
];

function board(title: string, lines: string[], accent: string) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const k = c.getContext('2d')!;
  k.fillStyle = '#1f2326'; k.fillRect(0, 0, 512, 320);
  k.fillStyle = accent; k.fillRect(0, 0, 512, 64);
  k.fillStyle = '#fff'; k.font = '700 38px system-ui, sans-serif'; k.fillText(title, 24, 46);
  k.font = '500 30px system-ui, sans-serif';
  lines.forEach((l, i) => { k.fillStyle = '#e9e4da'; k.fillText(l, 24, 120 + i * 58); });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t });
}
const MENUS: Record<string, [string, string[]]> = {
  coffee: ['Level G Café', ['Iced latte      9.00', 'Americano       6.00', 'Flat white      6.50']],
  bakery: ['Crumb Bakery', ['Croissant       4.50', 'Pain au choc    5.00', 'Sourdough       7.00']],
  noodles: ['Noodle House', ['Chicken noodle 12.50', 'Dumplings (6)   9.50', 'Wonton soup    11.00']],
  greens: ['Green Bowl', ['Caesar salad   11.00', 'Fruit cup       5.50', 'Grain bowl     12.00']],
};

/** Cups, pastries, bowls on each counter; a menu board and two warm pendant lights per shop. */
export function counters() {
  const g = new THREE.Group();
  const top = 0.97;
  for (const [x, accent, kind] of COUNTERS) {
    const [title, lines] = MENUS[kind];
    const b = add(g, new THREE.PlaneGeometry(0.95, 0.6), board(title, lines, accent), x, 4.12, 1.95);
    b.rotation.x = Math.PI / 2; // stand it up, facing the lobby (-y)
    for (const dx of [-0.45, 0.45]) {
      add(g, zup(new THREE.CylinderGeometry(0.004, 0.004, 0.5, 6)), lambert('#333'), x + dx, 3.4, 2.35);
      add(g, new THREE.SphereGeometry(0.075, 16, 12), lambert('#ffe2b0', { emissive: '#ffcf87', emissiveIntensity: 0.9 }), x + dx, 3.4, 2.07);
    }
    for (let i = 0; i < 4; i++) {
      const px = x - 0.5 + i * 0.3, py = 3.25 + (i % 2) * 0.08;
      if (kind === 'coffee') {
        add(g, zup(new THREE.CylinderGeometry(0.035, 0.028, 0.11, 14)), lambert(i % 2 ? '#f4efe6' : '#e8684a'), px, py, top + 0.055);
        add(g, zup(new THREE.CylinderGeometry(0.037, 0.037, 0.02, 14)), lambert('#3b2a20'), px, py, top + 0.12);
      } else if (kind === 'bakery') {
        add(g, new THREE.CapsuleGeometry(0.03, 0.08, 4, 10).rotateZ(Math.PI / 2 + i), lambert('#d99a4e'), px, py, top + 0.03).scale.set(1, 1, 0.75);
      } else {
        add(g, new THREE.SphereGeometry(0.07, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).rotateX(Math.PI / 2), lambert('#fafafa', { side: THREE.DoubleSide }), px, py, top + 0.07);
        add(g, zup(new THREE.CylinderGeometry(0.062, 0.062, 0.01, 16)), lambert(kind === 'noodles' ? '#e9c46a' : '#8ab17d'), px, py, top + 0.06);
      }
    }
  }
  return g;
}

// ---------- the robot ----------

/** Light up the robot's face screen and put the LiftDrop mark on the body side facing the camera. */
export function dressRobot(scene: THREE.Scene, meshes: (THREE.Mesh | null)[], at: THREE.Vector3) {
  const near = meshes.filter((m): m is THREE.Mesh => !!m).map((m) => {
    m.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(m);
    return { m, box, c: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
  }).filter(({ c }) => Math.hypot(c.x - at.x, c.y - at.y) < 0.45 && c.z > 0.05);
  // Face: the dark box highest up. Body: the biggest box.
  const face = near.filter(({ m }) => (m.material as THREE.MeshLambertMaterial).color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.2)
    .sort((a, b) => b.c.z - a.c.z)[0];
  if (face) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const k = c.getContext('2d')!;
    k.fillStyle = '#0d1418'; k.fillRect(0, 0, 256, 256);
    k.fillStyle = '#58e0ff'; k.shadowColor = '#58e0ff'; k.shadowBlur = 24;
    for (const ex of [88, 168]) { k.beginPath(); k.roundRect(ex - 18, 86, 36, 52, 18); k.fill(); }
    k.lineWidth = 10; k.strokeStyle = '#58e0ff'; k.beginPath(); k.arc(128, 150, 34, 0.15 * Math.PI, 0.85 * Math.PI); k.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    // The face is a box; a lit panel just in front of its outward (+x) side reads as a screen.
    const p = new THREE.Mesh(new THREE.PlaneGeometry(face.size.y * 0.86, face.size.z * 0.86), new THREE.MeshBasicMaterial({ map: t }));
    p.position.set(face.box.max.x + 0.002, face.c.y, face.c.z);
    p.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    scene.add(p);
  }
  // Body: the compartment cabinet is built from thin panels, so take the outline of every box
  // between the base plate and the head, and put the mark on its outer face.
  const panels = near.filter(({ m, c }) => m.geometry.type === 'BoxGeometry' && c.z > 0.25 && c.z < 1.0);
  const body = panels.length ? (() => {
    const box = panels.reduce((b, p) => b.union(p.box), new THREE.Box3());
    return { box, c: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
  })() : null;
  if (body) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const k = c.getContext('2d')!;
    k.fillStyle = '#e8684a'; k.beginPath(); k.roundRect(40, 78, 100, 100, 26); k.fill();
    k.fillStyle = '#fff'; k.font = '800 64px system-ui, sans-serif'; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillText('L', 90, 130);
    k.fillStyle = '#2b2d33'; k.textAlign = 'left'; k.font = '800 76px system-ui, sans-serif'; k.fillText('LiftDrop', 162, 132);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const w = body.size.y * 0.8;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 2), new THREE.MeshLambertMaterial({ map: t, transparent: true }));
    p.position.set(body.box.max.x + 0.002, body.c.y, body.c.z - body.size.z * 0.08);
    p.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    scene.add(p);
    // A thin status light strip along the base.
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.004, body.size.y * 0.9, 0.012), new THREE.MeshBasicMaterial({ color: '#58e0ff' }));
    strip.position.set(body.box.max.x + 0.003, body.c.y, body.box.min.z + 0.04);
    scene.add(strip);
  }
}

// ---------- lens ----------

/** Depth of field: whatever the page renders goes through a bokeh pass focused on the robot. */
export function lens(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: () => number, aperture: number, maxblur: number) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, { focus: focus(), aperture, maxblur });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  const size = new THREE.Vector2();
  const raw = renderer.render.bind(renderer);
  let inside = false;
  renderer.render = (s, c) => {
    if (inside) return raw(s, c); // the composer's own passes
    inside = true;
    renderer.getSize(size);
    composer.setSize(size.x, size.y);
    composer.setPixelRatio(renderer.getPixelRatio());
    (bokeh.uniforms as Record<string, { value: number }>).focus.value = focus();
    composer.render();
    inside = false;
  };
}
