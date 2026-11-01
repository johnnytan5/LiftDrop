// Copies the MuJoCo scene (sim/*.xml) and the official WASM build into public/ so the browser
// loads the same files the headless test does. Runs before dev and build. (From Concierge.)
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
for (const f of ['scene_tower.xml', 'liftdrop_bot.xml']) copy(join(root, 'sim', f), join(root, 'public', 'sim', f));
for (const f of ['mujoco.js', 'mujoco.wasm']) copy(join(root, 'node_modules', '@mujoco', 'mujoco', f), join(root, 'public', 'mujoco', f));
console.log('[sync-sim-assets] scene + MuJoCo WASM copied to public/');
