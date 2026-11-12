// Full delivery in the real MuJoCo tower scene, headless: node --test lib/sim/tower.test.ts
// Same WASM build and same Tower code the browser runs; ~10 s of wall time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tower, type SimEvent, type Stop } from './tower.ts';

const root = new URL('../../', import.meta.url);

async function scene() {
  const { default: load } = await import(new URL('node_modules/@mujoco/mujoco/mujoco.js', root).href);
  const mj = await load();
  mj.FS.mkdir('/sim');
  for (const f of ['scene_tower.xml', 'liftdrop_bot.xml']) mj.FS.writeFile(`/sim/${f}`, readFileSync(new URL(`sim/${f}`, root), 'utf8'));
  const m = mj.MjModel.from_xml_path('/sim/scene_tower.xml');
  const d = new mj.MjData(m);
  mj.mj_resetDataKeyframe(m, d, 0);
  mj.mj_forward(m, d);
  return { mj, m, d };
}

/** Run the sim until `p` settles, calling `onTick` between steps. */
async function run<T>(t: Tower, p: Promise<T>, onTick: () => void, maxSeconds = 400): Promise<T> {
  let done = false, out: T;
  p.then((v) => { done = true; out = v; });
  while (!done) {
    assert.ok(t.time < maxSeconds, `stuck in phase "${t.phase}" at ${JSON.stringify(t.status())}`);
    t.advance(0.02);
    onTick();
    await new Promise((r) => setImmediate(r));
  }
  return out!;
}

test('croissant taken, latte left: sensors report it and the latte goes back to the café', async () => {
  const { mj, m, d } = await scene();
  const events: (SimEvent & { at: string })[] = [];
  const t = new Tower(mj, m, d, (e) => events.push({ ...e, at: t.phase }));
  const stops: Stop[] = [
    { comp: 'A', shop: 'bakery', grams: 80, label: 'Crumb Bakery' },
    { comp: 'B', shop: 'cafe', grams: 450, label: 'Level G Café' },
  ];
  let took = false, maxZ = 0;
  const result = await run(t, t.deliver(stops, { doorTimeout: 15 }), () => {
    maxZ = Math.max(maxZ, t.pose().z);
    if (t.phase === 'calling customer') t.raise('unlock'); // the customer typed the right code
    if (!took && events.filter((e) => e.type === 'door_opened').length === 2) {
      took = true;
      t.take('A');
    }
  });

  const brief = events.map((e) => ('grams' in e ? `${e.type}:${e.compartment}:${e.grams}` : 'compartment' in e ? `${e.type}:${e.compartment}` : e.type));
  console.log('events', brief.join(' '), `| sim ${t.time.toFixed(0)} s`);

  const loaded = events.filter((e) => e.type === 'loaded') as { compartment: string; grams: number }[];
  assert.deepEqual(loaded.map((e) => e.compartment), ['B', 'A']); // café first, then bakery
  assert.ok(Math.abs(loaded[0].grams - 450) <= 10, `latte weighed ${loaded[0].grams}`);
  assert.ok(Math.abs(loaded[1].grams - 80) <= 10, `croissant weighed ${loaded[1].grams}`);
  assert.ok(maxZ > 6.4, `robot never reached L23 (max z ${maxZ})`);
  assert.ok(brief.includes('arrived'));
  const weights = events.filter((e) => e.type === 'weight') as { compartment: string; grams: number }[];
  // A drops to ~0 while the door is open; then the final reading per compartment at close.
  assert.deepEqual(weights.map((w) => [w.compartment, w.grams < 10]), [['A', true], ['B', false], ['A', true]]);
  assert.ok(Math.abs(weights[1].grams - 450) <= 10, `latte final ${weights[1].grams}`);
  assert.equal(brief.at(-1), 'timeout');
  assert.deepEqual(result.leftovers, ['B']);

  const p = t.pose();
  assert.ok(Math.hypot(p.x - 1, p.y + 2) < 0.1 && p.z < 0.2, `robot not back at the dock: ${JSON.stringify(p)}`);
  const bagB = d.xpos.subarray(m.nbody * 0 + 3 * mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'bag_B'));
  assert.ok(Math.hypot(bagB[0] + 0.2, bagB[1] - 3.3) < 0.3, `latte not back on the café counter: ${Array.from(bagB.subarray(0, 3))}`);
});

test('far west shops to level 20: noodles and greens, both bags taken, nothing left over', async () => {
  const { mj, m, d } = await scene();
  const events: SimEvent[] = [];
  const t = new Tower(mj, m, d, (e) => events.push(e));
  const stops: Stop[] = [
    { comp: 'A', shop: 'noodles', grams: 600, label: 'Noodle House' },
    { comp: 'B', shop: 'greens', grams: 350, label: 'Green Bowl' },
  ];
  let took = false, at = 0;
  const result = await run(t, t.deliver(stops, { doorTimeout: 15, floor: 20 }), () => {
    if (events.some((e) => e.type === 'arrived') && !at) at = t.status().floor;
    if (t.phase === 'calling customer') t.raise('unlock');
    if (!took && events.filter((e) => e.type === 'door_opened').length === 2) { took = true; t.take('A'); t.take('B'); }
  });
  const loaded = events.filter((e) => e.type === 'loaded') as { compartment: string; grams: number }[];
  assert.deepEqual(loaded.map((e) => e.compartment), ['A', 'B']); // noodles first, then greens (east to west)
  assert.ok(Math.abs(loaded[0].grams - 600) <= 10 && Math.abs(loaded[1].grams - 350) <= 10, JSON.stringify(loaded));
  assert.deepEqual(events.find((e) => e.type === 'arrived'), { type: 'arrived', floor: 20 });
  assert.equal(at, 20);
  assert.deepEqual(result.leftovers, []);
  const p = t.pose();
  assert.ok(Math.hypot(p.x - 1, p.y + 2) < 0.1 && p.z < 0.2, `robot not back at the dock: ${JSON.stringify(p)}`);
});

test('nobody enters the code: the compartments never open and both bags go back', async () => {
  const { mj, m, d } = await scene();
  const events: SimEvent[] = [];
  const t = new Tower(mj, m, d, (e) => events.push(e));
  const stops: Stop[] = [{ comp: 'A', shop: 'cafe', grams: 450, label: 'Level G Café' }];
  const result = await run(t, t.deliver(stops, { codeTimeout: 5 }), () => {});
  assert.ok(!events.some((e) => e.type === 'door_opened'), 'a locked compartment opened');
  assert.equal(events.at(-1)?.type, 'timeout');
  assert.ok(result.timedOut);
  assert.deepEqual(result.leftovers, ['A']);
});
