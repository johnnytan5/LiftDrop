/// <reference lib="webworker" />
/**
 * Tower physics in a Web Worker: the official MuJoCo WASM build running sim/scene_tower.xml
 * (copied to public/ by scripts/sync-sim-assets.mjs) and the Tower controller from tower.ts.
 * Adapted from Concierge's dashboard/lib/sim/sim.worker.ts.
 *
 * in : { type: 'deliver', stops, autoLoad?, doorTimeout?, awaitVerdict?, floor?, codeWaitMs? }
 *      { type: 'take', comp, fraction? }   customer lifts a bag out (fraction < 1 = fault)
 *      { type: 'raise', name }             'done', 'loaded:A', or the backend's verdict: 'settled' | 'reopen'
 *      { type: 'speed', x }                sim-time multiplier for the demo
 * out: { type: 'static', ... }             once: what to draw for every geom
 *      { type: 'frame', xpos, xmat, status }   ~30 Hz
 *      { type: 'event', event }            sensor event for /api/events
 *      { type: 'done', result } | { type: 'error', message }
 */
import { Tower } from './tower.ts';

const FRAME_HZ = 30;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let tower: Tower | null = null;
let model: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let speed = 1;
let busy = false;

async function init() {
  const url = '/mujoco/mujoco.js'; // runtime URL, not a bundled import: the WASM build is a static asset
  const { default: loadMujoco } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  const mj = await loadMujoco();
  mj.FS.mkdir('/sim');
  for (const f of ['scene_tower.xml', 'liftdrop_bot.xml']) {
    const res = await fetch(`/sim/${f}`);
    if (!res.ok) throw new Error(`could not load /sim/${f} (${res.status})`);
    mj.FS.writeFile(`/sim/${f}`, await res.text());
  }
  model = mj.MjModel.from_xml_path('/sim/scene_tower.xml');
  data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);
  tower = new Tower(mj, model, data, (event) => post({ type: 'event', event }));

  const ngeom: number = model.ngeom;
  const rgba = new Float32Array(ngeom * 4);
  const matid: Int32Array = model.geom_matid, geomRgba: Float32Array = model.geom_rgba, matRgba: Float32Array = model.mat_rgba;
  for (let i = 0; i < ngeom; i++) {
    const src = matid[i] >= 0 ? matRgba.subarray(matid[i] * 4, matid[i] * 4 + 4) : geomRgba.subarray(i * 4, i * 4 + 4);
    rgba.set(src, i * 4);
  }
  post({
    type: 'static', ngeom, rgba,
    geomType: Int32Array.from(model.geom_type),
    geomSize: Float64Array.from(model.geom_size),
    geomGroup: Int32Array.from(model.geom_group),
    // The bags' geoms, so the view can draw the real dishes on them instead of a box.
    bagGeom: Object.fromEntries((['A', 'B'] as const).map((c) => [c, Array.from(model.geom_bodyid as Int32Array).indexOf(mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, `bag_${c}`))])),
  });

  let lastWall = performance.now(), lastFrame = 0;
  setInterval(() => {
    const now = performance.now();
    // Step to wall-clock time, capped so a backgrounded tab doesn't replay minutes at once.
    tower!.advance(Math.min((now - lastWall) / 1000, 0.1) * speed);
    lastWall = now;
    if (now - lastFrame >= 1000 / FRAME_HZ) {
      lastFrame = now;
      const xpos = Float64Array.from(data.geom_xpos), xmat = Float64Array.from(data.geom_xmat);
      post({ type: 'frame', xpos, xmat, status: tower!.status() }, [xpos.buffer, xmat.buffer]);
    }
  }, 1000 / 120);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!tower) return;
  if (msg.type === 'deliver') {
    if (busy) return post({ type: 'error', message: 'robot is already on a delivery' });
    busy = true;
    tower.deliver(msg.stops, { autoLoad: msg.autoLoad, doorTimeout: msg.doorTimeout, awaitVerdict: msg.awaitVerdict, floor: msg.floor, codeWaitMs: msg.codeWaitMs })
      .then((result) => post({ type: 'done', result }))
      .catch((err) => post({ type: 'error', message: String(err?.message ?? err) }))
      .finally(() => { busy = false; });
  } else if (msg.type === 'take') tower.take(msg.comp, msg.fraction);
  else if (msg.type === 'raise') tower.raise(msg.name);
  else if (msg.type === 'speed') speed = msg.x;
};

init().catch((err) => post({ type: 'error', message: String(err?.message ?? err) }));
