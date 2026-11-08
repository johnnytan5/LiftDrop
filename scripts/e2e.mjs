// Customer E2E in real Chrome against the running app: the split-screen home page, the real
// MuJoCo sim in the browser, the real backend (Supabase + PayPal mock or sandbox + LLM).
//
//   npm run dev -- -p 3001                         # another terminal
//   node scripts/e2e.mjs [screenshot-dir]          # E2E_URL to point elsewhere
//
// Scenarios, one after another on the same page, like a person ordering three times:
//   1. assistant fills the cart -> pay -> robot delivers -> customer takes bag A only
//      -> charged $4.50, $9.00 released, latte returned to the café, bakery paid $4.05
//   2. customer takes both -> charged in full
//   3. customer takes nothing and taps done -> nothing charged
//   4. shops load by hand on /vendor   5. agent asks once on an unclear weight
//   6. the two far shops (noodles + greens); a third shop's + is disabled
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL ?? 'http://localhost:3001/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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

async function order({ ask, cart }) {
  if (ask) {
    await phone.getByLabel('What would you like?').fill(ask);
    await phone.getByRole('button', { name: 'Ask' }).click();
    await phone.locator('.assistant-reply').waitFor({ timeout: 20_000 });
    log(`assistant: "${await text('.assistant-reply')}"`);
  }
  for (const name of cart ?? []) await phone.getByRole('button', { name: `Add ${name}` }).click();
  await check(/\$13\.50/.test(await text('.total-row')), `cart total is $13.50 (${(await text('.total-row')).replace('\n', ' ')})`);
  await shot('cart');
  await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
  await waitText(phone, /Robot is heading to the shops|Picking up at/, 15_000, 'paid: payment held, robot dispatched');
  await shot('held');
  await waitText(phone, /On its way up to you/, 120_000, 'both bags loaded, robot heading for the lift');
  await shot('lift');
  await waitText(phone, /Your robot is at the pantry/, 120_000, 'robot at the L23 pantry, doors open');
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
const docked = () => waitText(stage, /robot docked/, 150_000, 'robot back at the dock');

// 1. Assistant, take only the croissant.
log('--- scenario 1: assistant order, croissant taken, latte left');
await order({ ask: 'one butter croissant and an iced latte please' });
await takeBag('A');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$4.50', released: '$9.00' });
const items = (await phone.locator('.bag-list li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
await check(/croissant.*taken/i.test(items.join('|')) && /latte.*returned to shop/i.test(items.join('|')), `receipt items: ${items.join(' | ')}`);
await waitText(stage, /Shops paid\s*\$4\.05(?! …)/, 60_000, 'bakery payout of $4.05 confirmed');
await docked();
await check(/returned B to the shop/.test(await text('.events')), 'latte carried back to the café');
await shot('docked');

// 2. Manual cart, take both.
log('--- scenario 2: both bags taken');
await phone.getByRole('button', { name: 'Order again' }).click();
await order({ cart: ['Butter croissant', 'Iced latte'] });
await takeBag('A');
await takeBag('B');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$13.50', released: '$0.00' });
await docked();

// 3. Nothing taken.
log('--- scenario 3: nothing taken');
await phone.getByRole('button', { name: 'Order again' }).click();
await order({ cart: ['Butter croissant', 'Iced latte'] });
await tapDone();
await receipt({ headline: /Not delivered, not charged/, charged: '$0.00', released: '$13.50' });
await docked();

// 4. Shops load by hand: the robot waits at each counter until the shop's tablet says Loaded.
log('--- scenario 4: shops tap Loaded on /vendor, customer takes both');
await stage.getByLabel('Shops load instantly').uncheck();
const tablet = await browser.newPage({ viewport: { width: 800, height: 900 } });
tablet.on('pageerror', (e) => errors.push(`vendor: ${e.message}`));
await phone.getByRole('button', { name: 'Order again' }).click();
for (const name of ['Butter croissant', 'Iced latte']) await phone.getByRole('button', { name: `Add ${name}` }).click();
await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
for (const [shop, comp, label] of [['cafe', 'B', 'Level G Café'], ['bakery', 'A', 'Crumb Bakery']]) {
  await waitText(stage, new RegExp(`loading at ${label}`), 90_000, `robot waiting at ${label}`);
  await page.waitForTimeout(3000);
  await check(new RegExp(`loading at ${label}`).test(await text('.phase')), `still waiting at ${label} without the shop's tap`);
  await tablet.goto(new globalThis.URL(`/vendor?shop=${shop}`, URL).href);
  await tablet.getByRole('button', { name: `Loaded into ${comp}` }).click();
  log(`${label} tapped "Loaded into ${comp}"`);
  if (shots) await tablet.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-vendor-${shop}.png` });
}
await waitText(phone, /Your robot is at the pantry/, 120_000, 'robot at the pantry after hand loading');
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
await order({ cart: ['Butter croissant', 'Iced latte'] });
await stage.getByRole('button', { name: 'Half-take A' }).click();
log('customer disturbs bag A (half its weight)');
await tapDone();
try { await phone.getByText(/One more check|Delivered|Not delivered/).first().waitFor({ timeout: 30_000 }); } catch { await fail('no handoff decision'); }
if (await phone.getByText('One more check').count()) {
  log(`agent asks: "${(await phone.locator('.door-card p').first().innerText())}"`);
  await waitText(stage, /at door, customer checking/, 20_000, 'robot reopened its doors and waits');
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
await check(/\$18\.00/.test(await text('.total-row')), `cart total is $18.00 (${(await text('.total-row')).replace('\n', ' ')})`);
await phone.getByRole('button', { name: /Pay with PayPal/ }).click();
await waitText(stage, /loading at Noodle House/, 90_000, 'robot at Noodle House');
await waitText(stage, /loading at Green Bowl/, 90_000, 'robot at Green Bowl');
await waitText(phone, /Your robot is at the pantry/, 150_000, 'robot at the pantry');
await shot('new-shops-at-door');
await takeBag('A');
await takeBag('B');
await tapDone();
await receipt({ headline: /Delivered/, charged: '$18.00', released: '$0.00' });
await docked();

const real = errors.filter((e) => !/Download the React DevTools|favicon/.test(e));
await check(real.length === 0, `no page errors${real.length ? `: ${real.join('\n')}` : ''}`);
log('PASS');
await browser.close();
