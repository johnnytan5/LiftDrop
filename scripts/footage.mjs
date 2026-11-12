// Demo footage for the video: drives the real app like e2e.mjs, but slowly, with a visible cursor,
// and records each scene to its own 1080p MP4 (Chrome screencast frames -> ffmpeg).
//
//   PAYPAL_MODE=mock npx next dev -p 3001        # mock PayPal: the Pay button approves by itself
//   node scripts/footage.mjs ~/Desktop/liftdrop-footage [scene...]   # scenes: order call vendor ops
//
// Each scene also writes <scene>.txt: what happens at which second, for cutting the voiceover.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.E2E_URL ?? 'http://localhost:3001';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [outArg = 'footage', ...only] = process.argv.slice(2);
const out = outArg.replace(/^~/, process.env.HOME);
mkdirSync(out, { recursive: true });
const FPS = 30;

// The caller's line for the call scene (macOS say), after the line's greeting.
const wav = join(tmpdir(), 'liftdrop-footage-caller.wav');
execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', '[[slnc 13000]] Yes, that is right. Can I get a butter croissant and an iced latte please? [[slnc 120000]]']);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', // the M-series GPU: 60 fps sim
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
] });

// A visible cursor that follows the (otherwise invisible) automated mouse, with a click ripple.
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(20,24,32,.55),0 2px 8px rgba(0,0,0,.35);pointer-events:none;transition:transform .12s';
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; }, true);
});`;

async function scene(name, size, fn) {
  if (only.length && !only.includes(name)) return;
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, permissions: ['microphone'] });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const frames = join(tmpdir(), `liftdrop-frames-${name}`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  const cdp = await ctx.newCDPSession(page);
  const got = []; // [file, timestamp]
  let recording = false;
  let lastAt = 0; // wall clock of the newest frame: a still ending sends no more frames
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    lastAt = Date.now();
    const f = join(frames, `${String(got.length).padStart(6, '0')}.jpg`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    got.push([f, metadata.timestamp ?? Date.now() / 1000]);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });

  let t0 = 0;
  const beats = [];
  const beat = (s) => { const t = recording ? (Date.now() - t0) / 1000 : 0; beats.push(`${t.toFixed(1).padStart(6)}s  ${s}`); console.log(`[${name}] ${t.toFixed(1)}s  ${s}`); };
  const h = {
    page, beat,
    rec: () => { recording = true; t0 = Date.now(); beat('recording starts'); },
    hold: (ms) => page.waitForTimeout(ms),
    /** Glide the cursor to the element, pause, click: what a person would do on camera. */
    tap: async (loc, pause = 350) => {
      await loc.scrollIntoViewIfNeeded();
      const b = await loc.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
      await page.waitForTimeout(pause);
      await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
      await page.waitForTimeout(250);
    },
    wait: async (scope, re, ms, what) => { await scope.getByText(re).first().waitFor({ timeout: ms }); beat(what); },
  };
  try {
    await fn(h);
  } catch (e) {
    console.error(`[${name}] FAILED: ${e.message}`);
    await page.screenshot({ path: join(out, `${name}-FAILED.png`) });
  }
  recording = false;
  const stopped = got.length ? got.at(-1)[1] + (Date.now() - lastAt) / 1000 : 0;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await ctx.close();
  if (got.length < 2) return console.error(`[${name}] no frames`);
  // Screencast frames arrive only when the page changes: hold each for its real duration.
  const list = got.map(([f, t], i) => `file '${f}'\nduration ${Math.max(0.001, (got[i + 1]?.[1] ?? stopped) - t).toFixed(4)}`).join('\n');
  writeFileSync(join(frames, 'list.txt'), `${list}\nfile '${got.at(-1)[0]}'\n`);
  const mp4 = join(out, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'),
    '-vf', `fps=${FPS},scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  writeFileSync(join(out, `${name}.txt`), beats.join('\n') + '\n');
  rmSync(frames, { recursive: true, force: true });
  console.log(`[${name}] saved ${mp4}${errors.length ? ` (page errors: ${errors.join('; ')})` : ''}`);
}

const HD = { width: 1920, height: 1080 };

async function home(h, speed = '2×') {
  await h.page.goto(`${BASE}/demo`);
  await h.page.evaluate(() => localStorage.clear());
  await h.page.reload();
  await h.page.locator('.stage').getByText(/Docked, waiting for an order/).waitFor({ timeout: 90_000 });
  await h.page.locator('.stage').getByRole('button', { name: speed }).click();
  await h.page.mouse.move(960, 700);
  return { phone: h.page.locator('.phone-frame'), stage: h.page.locator('.stage') };
}

// At the gate: the robot rings the phone; the code from the phone goes in on the robot's screen.
async function unlock(h, phone, stage) {
  await h.wait(phone, /Your robot is calling you/, 240_000, 'robot at the L23 gate, calling the customer');
  await h.hold(2500);
  const code = (await phone.locator('.cp-code').innerText()).replace(/\D/g, '');
  for (const d of code) await h.tap(stage.getByRole('button', { name: `Digit ${d}` }), 200);
  await h.wait(phone, /Your robot is at your gate/, 15_000, 'right code: compartments open');
  await h.hold(1500);
}

// 1. The whole product in one take: order on the phone, shops load the robot by hand, lift to
//    L23, code at the gate, the customer takes only the croissant, charged $4.50, latte returned.
await scene('order', HD, async (h) => {
  const { phone, stage } = await home(h);
  await stage.getByLabel('Shops load instantly').uncheck();
  h.rec();
  await h.hold(2500);
  for (const name of ['Butter croissant', 'Iced latte']) await h.tap(phone.getByRole('button', { name: `Add ${name}` }));
  await h.hold(800);
  await h.tap(phone.locator('.cp-cartbar'));
  h.beat('basket: $13.50, pay on delivery (PayPal holds the money)');
  await h.hold(3000);
  await h.tap(phone.getByRole('button', { name: /Pay with PayPal/ }));
  await h.wait(phone, /Robot is heading to the shops|Picking up at/, 20_000, 'PayPal approved: $13.50 held, robot dispatched');
  for (const [comp, label] of [['B', 'Level G Café'], ['A', 'Crumb Bakery']]) {
    await h.wait(stage, new RegExp(`loading at ${label}`), 120_000, `robot at ${label}: robot screen asks staff to load ${comp}, live camera opens`);
    await h.hold(3500);
    await h.tap(stage.getByRole('button', { name: `Loaded · close ${comp}` }), 500);
    h.beat(`${label} staff tap Loaded`);
  }
  await h.wait(stage, /lift ↑/, 120_000, 'riding the lift to L23');
  await unlock(h, phone, stage);
  await h.tap(stage.getByRole('button', { name: 'Take bag A' }));
  h.beat('customer takes the croissant, leaves the latte');
  await h.hold(3000);
  await h.tap(phone.getByRole('button', { name: 'I’ve taken my order' }));
  await h.wait(phone, /Delivered/, 60_000, 'receipt: charged $4.50, $9.00 released, latte returned');
  await phone.locator('.receipt').scrollIntoViewIfNeeded();
  await h.hold(6000);
  await h.wait(stage, /Shops paid/, 90_000, 'PayPal Payouts: bakery paid');
  await h.hold(4000);
  await h.wait(stage, /returning|handing back|Heading back/i, 60_000, 'robot heads back to return the latte');
  await h.hold(8000);
});

// 2. Ordering by phone call: real speech-to-text, Muse Spark fills the basket, approve in PayPal.
await scene('call', HD, async (h) => {
  const { phone } = await home(h);
  h.rec();
  await h.hold(1500);
  await h.tap(phone.getByRole('button', { name: 'Call your order' }));
  h.beat('call starts; the line greets Alex and confirms the floor');
  await phone.locator('.cp-bubbles li.caller:not(.partial)').first().waitFor({ timeout: 60_000 });
  h.beat('caller asks for a croissant and an iced latte');
  await phone.locator('.cp-callcard').waitFor({ timeout: 30_000 });
  h.beat('basket filled by voice');
  await h.hold(3000);
  const approve = phone.getByRole('button', { name: 'Approve in PayPal' });
  for (const say of ['That is everything, I would like to pay now.', 'Yes, please check out.']) {
    if (await approve.count()) break;
    if (!(await phone.locator('.cp-type').count())) await h.tap(phone.getByRole('button', { name: 'Type instead' }));
    await phone.getByLabel('Type to the order line').pressSequentially(say, { delay: 35 });
    await h.tap(phone.getByRole('button', { name: 'Send' }));
    await approve.waitFor({ timeout: 25_000 }).catch(() => {});
  }
  h.beat('the line reads back the order; Approve in PayPal');
  await h.hold(4000);
  await h.tap(approve);
  await h.wait(phone, /Approved/, 15_000, 'approved: robot on its way');
  await h.hold(6000);
});

// 3. The shop's tablet: bags to load, earnings paid by PayPal Payouts, final-sale switch.
await scene('vendor', HD, async (h) => {
  await h.page.goto(`${BASE}/vendor?shop=bakery`);
  await h.page.getByText(/Paid to you/).waitFor({ timeout: 30_000 });
  await h.page.mouse.move(960, 500);
  h.rec();
  await h.hold(3000);
  await h.page.mouse.wheel(0, 500); await h.hold(2500);
  await h.tap(h.page.getByRole('button', { name: /Green Bowl/ }));
  h.beat('Green Bowl: fresh food marked final sale');
  await h.hold(2500);
  await h.page.locator('.vd-menu').scrollIntoViewIfNeeded();
  await h.hold(3000);
  await h.page.mouse.wheel(0, 700); await h.hold(3500);
  h.beat('recent orders: sold, came back, final sale');
  await h.hold(2000);
});

// 4. Operations: the fleet and anything that needs a person.
await scene('ops', HD, async (h) => {
  await h.page.goto(`${BASE}/ops`);
  await h.page.waitForTimeout(3000); // it polls, so it never goes network-idle
  await h.page.mouse.move(960, 500);
  h.rec();
  await h.hold(4000);
  await h.page.mouse.wheel(0, 600); await h.hold(4000);
});

await browser.close();
