// Render the /cover still at 4K for the slides: node scripts/cover.mjs out.png "cam=..&at=..&fov=.."
import { chromium } from 'playwright-core';

const [out = 'cover.png', query = ''] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`${process.env.BASE ?? 'http://localhost:3001'}/cover?${query}`);
await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 60_000 });
await page.waitForTimeout(2500); // the camera eases onto the robot
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
