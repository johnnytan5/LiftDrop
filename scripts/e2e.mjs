// Customer E2E in real Chrome against the running app: the split-screen home page, the real
// MuJoCo sim in the browser, the real backend (Supabase + PayPal mock or sandbox + LLM).
//
//   npm run dev -- -p 3001                         # another terminal
//   node scripts/e2e.mjs [screenshot-dir]          # E2E_URL to point elsewhere
//
// Scenarios, one after another on the same page, like a person ordering three times:
//   1. customer CALLS the order line (Chrome's fake mic plays a spoken request; real AssemblyAI
//      speech-to-text + Muse Spark + AssemblyAI voice) -> approve in PayPal -> robot delivers
//      -> customer takes bag A only
//      -> charged $4.50, $9.00 released, latte returned to the café, bakery paid $4.27
//   2. customer takes both -> charged in full
//   3. customer takes nothing and taps done -> nothing charged
//   4. shops load by hand on /vendor   5. agent asks once on an unclear weight
//   6. the two far shops (noodles + greens); a third shop's + is disabled
// Every order is pay on delivery: PayPal holds the total and captures only what's taken.
// Every handoff also uses the compartment cameras (SAM 3.1 via /api/vision).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL ?? 'http://localhost:3001/demo';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

// The caller's voice for scenario 1 (macOS say). It waits out the greeting (the echo gate mutes
// the mic while the line speaks) and ends in long silence because the fake mic loops it.
const wav = join(tmpdir(), 'liftdrop-caller.wav');
execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', '[[slnc 14000]] Yes, that is right. Can I get a butter croissant and an iced latte please? [[slnc 120000]]']);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ['microphone'] })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });

const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
let n = 0;
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png` }); };
const phone = page.locator('.phone-frame');
const stage = page.locator('.stage');
const text = (sel) => page.locator(sel).first().innerText();
const fail = async (msg) => { await shot('FAILED'); console.error(`FAIL: ${msg}`); if (errors.length) console.error(errors.join('\n')); await browser.close(); process.exit(1); };
const check = async (ok, msg) => { if (!ok) await fail(msg); else log(`ok  ${msg}`); };
const waitText = async (scope, re, ms, what) => {
  try { await scope.getByText(re).first().waitFor({ timeout: ms }); } catch { await fail(`timed out waiting for ${what} (${re})`); }
  log(what);
};
const moneyRow = async (label) => (await phone.locator('.receipt-row', { hasText: label }).first().innerText()).split('\n').at(-1).trim();

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await waitText(stage, /Docked, waiting for an order/, 90_000, 'MuJoCo loaded, robot docked');
await stage.getByRole('button', { name: '4×' }).click();
await shot('ready');

async function delivered() {
  await waitText(phone, /Robot is heading to the shops|Picking up at/, 15_000, 'paid: payment held, robot dispatched');
  await shot('held');
  await waitText(phone, /On its way up to you/, 120_000, 'both bags loaded, robot heading for the lift');
  await shot('lift');
  await atGate(120_000, 'robot at the L23 gate, doors open');
  await shot('at-door');
}

async function order(cart) {
  for (const name of cart) await phone.getByRole('button', { name: `Add ${name}` }).click();
  await phone.locator('.cp-cartbar').click();
  await check(/\$13\.50/.test(await text('.total-row')), `basket total is $13.50 (${(await text('.total-row')).replace('\n', ' ')})`);
  await shot('basket');
  await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
  await delivered();
}

async function callOrder() {
  await phone.getByRole('button', { name: 'Call your order' }).click();
  try { await phone.locator('.cp-bubbles li.caller:not(.partial)').first().waitFor({ timeout: 45_000 }); } catch { await fail('the order line never heard the caller'); }
  log(`caller said: "${await phone.locator('.cp-bubbles li.caller').first().innerText()}"`);
  try { await phone.locator('.cp-callcard').waitFor({ timeout: 30_000 }); } catch { await fail('Muse Spark did not fill the basket'); }
  log(`line: "${await phone.locator('.cp-bubbles li.agent').last().innerText()}"`);
  await check(/Butter croissant.*Iced latte|Iced latte.*Butter croissant/.test(await text('.cp-callcard-items')) && /\$13\.50/.test(await text('.cp-callcard')), `basket filled by voice: ${await text('.cp-callcard-items')}`);
  await shot('call-basket');
  // Finish by typing (the fake mic only says one line). Spark may ask once more before checking out.
  const approve = phone.getByRole('button', { name: 'Approve in PayPal' });
  for (const say of ['That is everything, I would like to pay now.', 'Yes, please check out.', 'Check out please.']) {
    if (!(await phone.locator('.cp-type').count())) await phone.getByRole('button', { name: 'Type instead' }).click();
    await phone.getByLabel('Type to the order line').fill(say);
    await phone.getByRole('button', { name: 'Send' }).click();
    log(`caller types: "${say}"`);
    try { await approve.waitFor({ timeout: 25_000 }); break; } catch { log(`line: "${await phone.locator('.cp-bubbles li.agent').last().innerText()}"`); }
  }
  if (!(await approve.count())) await fail('Muse Spark never checked out');
  log(`line: "${await phone.locator('.cp-bubbles li.agent').last().innerText()}"`);
  await shot('call-approve');
  await approve.click();
  await waitText(phone, /Approved/, 15_000, 'PayPal approved on the call');
  await shot('call-approved');
  // The line says goodbye first; at 4× the robot may already be past the shops by then.
  try { await phone.locator('.cp-trackhead').waitFor({ timeout: 40_000 }); } catch { await fail('call never hung up after PayPal approval'); }
  log(`call ended, phone tracking: "${await text('.cp-trackhead .headline')}"`);
  await atGate(120_000, 'robot at the L23 gate, doors open');
  await shot('at-door');
}

async function receipt({ headline, charged, released }) {
  await waitText(phone, headline, 40_000, `receipt: ${headline}`);
  await phone.locator('.receipt').waitFor();
  await check(await moneyRow('Charged') === charged, `charged ${charged} (got ${await moneyRow('Charged')})`);
  await check(await moneyRow('Released') === released, `released ${released} (got ${await moneyRow('Released')})`);
  await shot('receipt');
}

const takeBag = async (c) => { await stage.getByRole('button', { name: `Take bag ${c}` }).click(); log(`customer lifts bag ${c}`); };
const tapDone = async () => {
  await page.waitForTimeout(2500); // let the scale settle and report
  await phone.getByRole('button', { name: 'I’ve taken my order' }).click();
  log('customer taps "I’ve taken my order"');
};
// The robot rings the phone and stays locked until the code from the phone is typed on its screen.
async function atGate(ms, what) {
  await waitText(phone, /Your robot is calling you/, ms, `${what}: robot calling, compartments locked`);
  const code = (await phone.locator('.cp-code').innerText()).replace(/\D/g, '');
  await check(/^\d{4}$/.test(code), `phone shows a 4-digit code (${code})`);
  for (const d of code) await stage.getByRole('button', { name: `Digit ${d}` }).click();
  log('code typed on the robot\'s screen');
  await waitText(phone, /Your robot is at your gate/, 15_000, `${what}: unlocked, doors open`);
}
const docked = () => waitText(stage, /robot docked/, 150_000, 'robot back at the dock');

// 1. Assistant, take only the croissant.
await stage.getByLabel('Shops load instantly').check(); // scenarios 1-3 skip the hand loading (scenario 4 covers it)
log('--- scenario 1: order by phone call, croissant taken, latte left');
await callOrder();
await takeBag('A');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$4.50', released: '$9.00' });
const items = (await phone.locator('.bag-list li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
await check(/croissant.*taken/i.test(items.join('|')) && /latte.*returned to shop/i.test(items.join('|')), `receipt items: ${items.join(' | ')}`);
await waitText(stage, /Shops paid\s*\$4\.27(?! …)/, 60_000, 'bakery payout of $4.27 confirmed');
await docked();
await check(/returned B to the shop/.test(await text('.events')), 'latte carried back to the café');
const cams = (await stage.locator('.cam figcaption').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
await check(cams.some((t) => /^A empty: taken/.test(t)) && cams.some((t) => /^B still there/.test(t)), `SAM 3.1 compartment cameras: ${cams.join(' | ')}`);
await check(/camera A after: SAM 3\.1 sees 0 of 1/.test(await text('.events')) && /camera B after: SAM 3\.1 sees 1 of 1/.test(await text('.events')), 'camera checks logged before the doors closed');
await shot('docked');

// 2. Manual cart, take both.
log('--- scenario 2: both bags taken');
await phone.getByRole('button', { name: 'Order again' }).click();
await order(['Butter croissant', 'Iced latte']);
await takeBag('A');
await takeBag('B');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$13.50', released: '$0.00' });
await docked();

// 3. Nothing taken.
log('--- scenario 3: nothing taken');
await phone.getByRole('button', { name: 'Order again' }).click();
await order(['Butter croissant', 'Iced latte']);
await tapDone();
await receipt({ headline: /Not delivered, not charged/, charged: '$0.00', released: '$13.50' });
await docked();

// 4. Shops load by hand: the robot waits at each counter until staff tap Loaded on its screen.
log('--- scenario 4: staff tap Loaded on the robot, customer takes both');
await stage.getByLabel('Shops load instantly').uncheck();
const tablet = await browser.newPage({ viewport: { width: 800, height: 900 } });
tablet.on('pageerror', (e) => errors.push(`vendor: ${e.message}`));
await phone.getByRole('button', { name: 'Order again' }).click();
for (const name of ['Butter croissant', 'Iced latte']) await phone.getByRole('button', { name: `Add ${name}` }).click();
await phone.locator('.cp-cartbar').click();
await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
for (const [shop, comp, label] of [['cafe', 'B', 'Level G Café'], ['bakery', 'A', 'Crumb Bakery']]) {
  await waitText(stage, new RegExp(`loading at ${label}`), 90_000, `robot waiting at ${label}`);
  await page.waitForTimeout(3000);
  await check(new RegExp(`loading at ${label}`).test(await text('.phase')), `still waiting at ${label} without the shop's tap`);
  await check(await stage.locator('.livecam').isVisible(), `live inside camera on compartment ${comp}`);
  await stage.getByRole('button', { name: `Loaded · close ${comp}` }).click();
  log(`${label} staff tapped "Loaded" on the robot's screen (${shop} → ${comp})`);
  await shot(`robot-screen-${shop}`);
}
await atGate(120_000, 'robot at the gate after hand loading');
await takeBag('A');
await takeBag('B');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$13.50', released: '$0.00' });
await tablet.goto(new globalThis.URL('/vendor?shop=bakery', URL).href);
await tablet.getByText(/Paid to you/).waitFor();
if (shots) await tablet.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-vendor-earnings.png` });
await docked();
await stage.getByLabel('Shops load instantly').check();

// 5. Unclear handoff: half the croissant's weight leaves A. The agent may ask once; A is never
//    charged because the sensors never confirmed it was taken.
log('--- scenario 5: weight doesn’t match, agent decides');
await phone.getByRole('button', { name: 'Order again' }).click();
await order(['Butter croissant', 'Iced latte']);
await stage.getByRole('button', { name: 'Half-take A' }).click();
log('customer disturbs bag A (half its weight)');
await tapDone();
try { await phone.getByText(/One more check|Delivered|Not delivered/).first().waitFor({ timeout: 30_000 }); } catch { await fail('no handoff decision'); }
if (await phone.getByText('One more check').count()) {
  log(`agent asks: "${(await phone.locator('.door-card p').first().innerText())}"`);
  await waitText(stage, /at the gate, customer checking/, 20_000, 'robot reopened its doors and waits');
  await shot('agent-asks');
  await takeBag('A'); // the customer takes the croissant properly this time
  await page.waitForTimeout(2500);
  await phone.getByRole('button', { name: 'Done' }).click();
  log('customer taps "Done" again');
  await receipt({ headline: /Delivered/, charged: '$4.50', released: '$9.00' });
} else {
  log('agent settled without asking');
  await receipt({ headline: /Not delivered, not charged|Delivered/, charged: '$0.00', released: '$13.50' });
}
await docked();

// 6. The two new shops at the far end of the lobby; a third shop can't be added.
log('--- scenario 6: Noodle House + Green Bowl, third shop blocked');
await phone.getByRole('button', { name: 'Order again' }).click();
for (const name of ['Chicken noodle soup', 'Fresh fruit cup']) await phone.getByRole('button', { name: `Add ${name}` }).click();
await check(await phone.getByRole('button', { name: 'Add Butter croissant' }).isDisabled(), 'third shop disabled: robot carries from two shops');
await phone.locator('.cp-cartbar').click();
await check(/\$18\.00/.test(await text('.total-row')), `basket total is $18.00 (${(await text('.total-row')).replace('\n', ' ')})`);
await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
await waitText(stage, /loading at Noodle House/, 90_000, 'robot at Noodle House');
await waitText(stage, /loading at Green Bowl/, 90_000, 'robot at Green Bowl');
await atGate(150_000, 'robot at the gate');
await shot('new-shops-at-door');
await takeBag('A');
await takeBag('B');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$18.00', released: '$0.00' });
await docked();

const real = errors.filter((e) => !/Download the React DevTools|favicon|images\.unsplash\.com/.test(e));
await check(real.length === 0, `no page errors${real.length ? `: ${real.join('\n')}` : ''}`);
log('PASS');
await browser.close();
