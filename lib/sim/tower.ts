// The robot's brain in the tower scene (sim/scene_tower.xml). Pure logic over a MuJoCo model,
// no DOM: the browser runs it in sim.worker.ts, the Node test runs the same code headless.
//
// The robot drives by setting its base velocity each physics step (x, y, yaw only; z is left
// to physics so it rides the lift car). Everything the backend learns comes from sensors:
// load-cell grams per compartment, door positions, and where the robot is.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mj = any;

export type Comp = 'A' | 'B';
export type Shop = 'cafe' | 'bakery' | 'noodles' | 'greens';
export type Stop = { comp: Comp; shop: Shop; grams: number; label: string };
export type SimEvent =
  | { type: 'loaded'; compartment: Comp; grams: number }
  | { type: 'arrived'; floor: number }
  | { type: 'door_opened'; compartment: Comp }
  | { type: 'weight'; compartment: Comp; grams: number }
  | { type: 'door_closed'; compartment: Comp }
  | { type: 'timeout' }
  // Doors about to close: the stage photographs the compartment now (not sent to the backend).
  | { type: 'snapshot'; compartment: Comp };

type XY = [number, number];

// ponytail: tuning knobs for the demo, not physics truth.
const V_MAX = 0.8;          // m/s
const W_MAX = 1.6;          // rad/s
const A_MAX = 0.8;          // m/s²: faster and the tall cabinet tips over
const ALPHA_MAX = 3;        // rad/s²
const LIFT_SPEED = 0.6;     // m/s
const PLATE_TARE_G = 50;    // load-cell plate mass in the XML
const WEIGHT_STEP_G = 15;   // smallest change reported as a new weight
const L23_Z = 3.2;

const LOBBY = { dock: [1, -2] as XY, corridor: [1, 2.6] as XY, liftDoor: [2.5, 0] as XY, liftIn: [4.5, 0] as XY };
const L23 = { liftOut: [3.0, 0] as XY, bend: [1.7, -1.5] as XY, approach: [1.7, -2.75] as XY, pantry: [2.4, -2.75] as XY };
// Stop on y=2.6 heading west: the compartments (robot's -y side) face the counter to the north.
export const SHOPS: Record<Shop, { stop: XY; counter: [number, number, number] }> = {
  cafe: { stop: [0.1, 2.6], counter: [-0.2, 3.3, 0.95] },
  bakery: { stop: [-1.95, 2.6], counter: [-2.25, 3.3, 0.95] },
  noodles: { stop: [-4, 2.6], counter: [-4.3, 3.3, 0.95] },
  greens: { stop: [-6.05, 2.6], counter: [-6.35, 3.3, 0.95] },
};
const VISIT_ORDER: Shop[] = ['cafe', 'bakery', 'noodles', 'greens']; // east to west along the counters

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, lim: number) => Math.max(-lim, Math.min(lim, x));

export class Tower {
  phase = 'idle';
  time = 0;
  private drive: { path: XY[]; idx: number } | null = null;
  private faceYaw: number | null = null;
  private liftTarget = 0;
  private liftCtrl = 0;
  private v = 0;
  private w = 0;
  private waiters: { cond: () => boolean; resolve: () => void }[] = [];
  private flags = new Set<string>();
  private shown = { A: 0, B: 0 }; // display only: last reading taken while standing still
  private watching: Partial<Record<Comp, { reported: number; candidate: number; since: number }>> = {};
  private id: Record<string, number> = {};
  private mj: Mj;
  private m: Mj;
  private d: Mj;
  private emit: (e: SimEvent) => void;

  constructor(mj: Mj, m: Mj, d: Mj, emit: (e: SimEvent) => void = () => {}) {
    this.mj = mj; this.m = m; this.d = d; this.emit = emit;
    const O = mj.mjtObj;
    const look = (kind: any, name: string) => {
      const i = mj.mj_name2id(m, kind.value, name);
      if (i < 0) throw new Error(`model has no ${name}`);
      return i;
    };
    for (const n of ['robot', 'bag_A', 'bag_B']) this.id[`body:${n}`] = look(O.mjOBJ_BODY, n);
    for (const n of ['robot', 'bag_A', 'bag_B', 'lift']) this.id[`joint:${n}`] = look(O.mjOBJ_JOINT, n);
    for (const n of ['door_A', 'door_B', 'lift']) this.id[`act:${n}`] = look(O.mjOBJ_ACTUATOR, n);
    for (const n of ['scale_A', 'scale_B', 'door_A', 'door_B', 'lift']) this.id[`sensor:${n}`] = look(O.mjOBJ_SENSOR, n);
    for (const n of ['slot_A', 'slot_B', 'pantry_drop']) this.id[`site:${n}`] = look(O.mjOBJ_SITE, n);
  }

  // ---------- state readers ----------

  pose() {
    const q = this.d.qpos, a = this.m.jnt_qposadr[this.id['joint:robot']];
    const [w, x, y, z] = [q[a + 3], q[a + 4], q[a + 5], q[a + 6]];
    return { x: q[a], y: q[a + 1], z: q[a + 2], yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) };
  }

  private sensor(name: string, i = 0) {
    return this.d.sensordata[this.m.sensor_adr[this.id[`sensor:${name}`]] + i];
  }

  /** Load-cell reading in grams (plate tare removed). Only meaningful while the robot is still. */
  grams(c: Comp) {
    return Math.max(0, Math.round(Math.abs(this.sensor(`scale_${c}`, 2)) / 9.81 * 1000 - PLATE_TARE_G));
  }

  /** Is the bag physically inside its compartment? What a compartment camera would see; never the scale. */
  inSlot(c: Comp) {
    const b = this.id[`body:bag_${c}`], [sx, sy, sz] = this.sitePos(`slot_${c}`);
    const p = this.d.xpos.subarray(b * 3, b * 3 + 3);
    return Math.hypot(p[0] - sx, p[1] - sy, p[2] - sz) < 0.15;
  }

  doorOpen(c: Comp) { return this.sensor(`door_${c}`) > 0.25; }
  doorClosed(c: Comp) { return this.sensor(`door_${c}`) < 0.01; }
  liftZ() { return this.sensor('lift'); }

  status() {
    const p = this.pose();
    return {
      phase: this.phase, time: this.time, x: p.x, y: p.y, z: p.z, yaw: p.yaw, floor: p.z > L23_Z / 2 ? 23 : 0,
      lift: this.liftZ(), grams: this.displayGrams(),
      doors: { A: this.sensor('door_A'), B: this.sensor('door_B') },
      inSlot: { A: this.inSlot('A'), B: this.inSlot('B') },
    };
  }

  /** Load cells read acceleration too, so the live readout holds its last still reading while moving. */
  private displayGrams() {
    const still = Math.abs(this.v) < 0.02 && Math.abs(this.w) < 0.05 && Math.abs(this.liftTarget - this.liftCtrl) < 1e-3;
    if (still) this.shown = { A: this.grams('A'), B: this.grams('B') };
    return { ...this.shown };
  }

  // ---------- physics loop ----------

  /** Step the physics by `seconds`, running the controllers and waking any awaiting tasks. */
  advance(seconds: number) {
    const dt = this.m.opt.timestep;
    for (let n = Math.round(seconds / dt); n > 0; n--) {
      this.control(dt);
      this.mj.mj_step(this.m, this.d);
      this.time += dt;
    }
    this.watchWeights();
    const ready = this.waiters.filter((w) => w.cond());
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }

  private control(dt: number) {
    // Lift: ramp the position target so the car accelerates gently with the robot on board.
    this.liftCtrl += clamp(this.liftTarget - this.liftCtrl, LIFT_SPEED * dt);
    this.d.ctrl[this.id['act:lift']] = this.liftCtrl;

    const p = this.pose();
    let v = 0, w = 0;
    if (this.drive) {
      const { path } = this.drive;
      const last = this.drive.idx === path.length - 1;
      const [tx, ty] = path[this.drive.idx];
      const dist = Math.hypot(tx - p.x, ty - p.y);
      if (dist < (last ? 0.04 : 0.2)) {
        if (last) this.drive = null; else this.drive.idx++;
      } else {
        const err = wrap(Math.atan2(ty - p.y, tx - p.x) - p.yaw);
        w = clamp(3 * err, W_MAX);
        // Brake in time for the final point (v <= sqrt(2 a d)); corners keep speed.
        if (Math.abs(err) < 0.35) v = Math.min(V_MAX, last ? Math.max(0.1, Math.sqrt(2 * A_MAX * 0.8 * dist)) : V_MAX) * Math.cos(err);
      }
    } else if (this.faceYaw !== null) {
      const err = wrap(this.faceYaw - p.yaw);
      if (Math.abs(err) < 0.01) this.faceYaw = null; else w = clamp(3 * err, W_MAX);
    }
    // Rate-limit like a motor controller would; an instant 0 -> 0.8 m/s topples the robot.
    this.v += clamp(v - this.v, A_MAX * dt);
    this.w += clamp(w - this.w, ALPHA_MAX * dt);
    const a = this.m.jnt_dofadr[this.id['joint:robot']];
    this.d.qvel[a] = this.v * Math.cos(p.yaw);
    this.d.qvel[a + 1] = this.v * Math.sin(p.yaw);
    this.d.qvel[a + 5] = this.w;
  }

  // ---------- primitive actions (await-able) ----------

  until(cond: () => boolean) {
    return new Promise<void>((resolve) => (cond() ? resolve() : this.waiters.push({ cond, resolve })));
  }
  sleep(s: number) { const t = this.time + s; return this.until(() => this.time >= t); }

  /** External signal from the UI (vendor "Loaded", customer "Done", ...). */
  raise(name: string) { this.flags.add(name); }
  private signal(name: string) {
    return this.until(() => this.flags.has(name)).then(() => void this.flags.delete(name));
  }

  async goto(path: XY[], faceYaw?: number) {
    this.drive = { path, idx: 0 };
    await this.until(() => this.drive === null);
    if (faceYaw !== undefined) {
      this.faceYaw = faceYaw;
      await this.until(() => this.faceYaw === null);
    }
  }

  async rideLift(z: number) {
    this.liftTarget = z;
    await this.until(() => Math.abs(this.liftZ() - z) < 0.01 && Math.abs(this.liftCtrl - z) < 1e-6);
    await this.sleep(0.3);
  }

  async door(c: Comp, open: boolean) {
    this.d.ctrl[this.id[`act:door_${c}`]] = open ? 0.3 : 0;
    await this.until(() => (open ? this.doorOpen(c) : this.doorClosed(c)));
  }

  /** Teleport a free body (bags only) and zero its velocity. */
  private placeBody(name: string, pos: ArrayLike<number>, quat?: ArrayLike<number>) {
    const j = this.id[`joint:${name}`];
    const qa = this.m.jnt_qposadr[j], va = this.m.jnt_dofadr[j];
    for (let i = 0; i < 3; i++) this.d.qpos[qa + i] = pos[i];
    const qq = quat ?? [1, 0, 0, 0];
    for (let i = 0; i < 4; i++) this.d.qpos[qa + 3 + i] = qq[i];
    for (let i = 0; i < 6; i++) this.d.qvel[va + i] = 0;
    this.mj.mj_forward(this.m, this.d);
  }

  private setBagGrams(c: Comp, grams: number) {
    this.m.body_mass[this.id[`body:bag_${c}`]] = grams / 1000;
  }

  private sitePos(name: string) {
    const i = this.id[`site:${name}`];
    return Array.from(this.d.site_xpos.subarray(i * 3, i * 3 + 3)) as number[];
  }

  // ---------- customer actions at the door ----------

  /** Customer lifts the bag out (fraction 1), or a fault: only part of the weight leaves. */
  take(c: Comp, fraction = 1) {
    if (fraction >= 1) {
      const [x, y, z] = this.sitePos('pantry_drop');
      this.placeBody(`bag_${c}`, [x + (c === 'A' ? -0.25 : 0.25), y, z]);
    } else {
      const b = this.id[`body:bag_${c}`];
      this.m.body_mass[b] = this.m.body_mass[b] * (1 - fraction);
    }
  }

  /** Report weight changes once a reading has held steady (sensor-driven, not UI-driven). */
  private watchWeights() {
    for (const c of Object.keys(this.watching) as Comp[]) {
      const s = this.watching[c]!;
      const g = this.grams(c);
      if (Math.abs(g - s.candidate) > 3) { s.candidate = g; s.since = this.time; continue; }
      if (Math.abs(s.candidate - s.reported) >= WEIGHT_STEP_G && this.time - s.since > 0.4) {
        s.reported = s.candidate;
        this.emit({ type: 'weight', compartment: c, grams: s.reported });
      }
    }
  }

  // ---------- the delivery mission ----------

  /** Park each order bag on its shop's counter, weighted like the real items. */
  stage(stops: Stop[]) {
    for (const s of stops) {
      this.setBagGrams(s.comp, s.grams);
      this.placeBody(`bag_${s.comp}`, SHOPS[s.shop].counter);
    }
  }

  /** awaitVerdict: after closing the doors, wait for raise('settled') or raise('reopen') (the
   *  backend's handoff agent asked the customer to check a compartment) before leaving. */
  async deliver(stops: Stop[], opts: { autoLoad?: boolean; doorTimeout?: number; awaitVerdict?: boolean } = {}) {
    const { autoLoad = true, doorTimeout = 45, awaitVerdict = false } = opts;
    const route = VISIT_ORDER.flatMap((shop) => stops.filter((s) => s.shop === shop));
    this.stage(route);

    // 1. Collect from each counter.
    let from: XY[] = [LOBBY.corridor];
    for (const s of route) {
      this.phase = `to ${s.label}`;
      await this.goto([...from, SHOPS[s.shop].stop], Math.PI);
      this.phase = `loading at ${s.label}`;
      await this.door(s.comp, true);
      await (autoLoad ? this.sleep(1.5) : this.signal(`loaded:${s.comp}`));
      const slot = this.sitePos(`slot_${s.comp}`);
      this.placeBody(`bag_${s.comp}`, slot, this.d.xquat.subarray(this.id['body:robot'] * 4, this.id['body:robot'] * 4 + 4));
      await this.door(s.comp, false);
      await this.sleep(0.6);
      this.emit({ type: 'loaded', compartment: s.comp, grams: this.grams(s.comp) });
      from = [];
    }

    // 2. Lift to level 23.
    this.phase = 'to lift';
    await this.goto([[SHOPS[route.at(-1)!.shop].stop[0] + 0.5, 1.2], LOBBY.liftDoor, LOBBY.liftIn], 0);
    this.phase = 'lift ↑ L23';
    await this.rideLift(L23_Z);

    // 3. Pantry handoff.
    this.phase = 'to pantry';
    await this.goto([L23.liftOut, L23.bend, L23.approach, L23.pantry], 0);
    this.emit({ type: 'arrived', floor: 23 });
    let timedOut = false;
    for (let round = 0; ; round++) {
      this.phase = round ? 'at door, customer checking' : 'at door';
      this.flags.delete('done');
      for (const s of route) {
        await this.door(s.comp, true);
        this.emit({ type: 'door_opened', compartment: s.comp });
        const g = this.grams(s.comp);
        this.watching[s.comp] = { reported: g, candidate: g, since: this.time };
      }
      timedOut = await Promise.race([this.signal('done').then(() => false), this.sleep(doorTimeout).then(() => true)]);
      await this.sleep(0.6); // let the last weight change settle and report
      this.watching = {};
      for (const s of route) this.emit({ type: 'snapshot', compartment: s.comp });
      // Final reading per compartment, so an untouched one reads "still full", not "unknown".
      for (const s of route) this.emit({ type: 'weight', compartment: s.comp, grams: this.grams(s.comp) });
      for (const s of route) {
        await this.door(s.comp, false);
        if (!timedOut) this.emit({ type: 'door_closed', compartment: s.comp });
      }
      if (timedOut) this.emit({ type: 'timeout' });
      if (!awaitVerdict) break;
      this.phase = 'checking handoff';
      const verdict = await Promise.race([this.signal('settled').then(() => 'settled'), this.signal('reopen').then(() => 'reopen'), this.sleep(60).then(() => 'settled')]);
      this.flags.delete('settled'); this.flags.delete('reopen');
      if (verdict === 'settled' || round >= 2) break;
    }

    // 4. Home, returning anything left in a compartment to its shop.
    this.phase = 'returning';
    await this.goto([L23.approach, L23.bend, L23.liftOut, [4.5, 0]], 0);
    await this.rideLift(0);
    const leftovers = route.filter((s) => this.grams(s.comp) > WEIGHT_STEP_G);
    let back: XY[] = [LOBBY.liftDoor];
    for (const s of [...leftovers].reverse()) {
      this.phase = `returning item to ${s.label}`;
      await this.goto([...back, [SHOPS[s.shop].stop[0] + 0.5, 1.2], SHOPS[s.shop].stop], Math.PI);
      await this.door(s.comp, true);
      this.placeBody(`bag_${s.comp}`, SHOPS[s.shop].counter);
      await this.door(s.comp, false);
      back = [];
    }
    this.phase = 'to dock';
    await this.goto([...back, [1, 0.5], LOBBY.dock], 0);
    this.phase = 'idle';
    return { timedOut, leftovers: leftovers.map((s) => s.comp) };
  }
}
