// Refresh docs/screenshots/*.png against a seeded instance.
//   node scripts/screenshots.mjs
// Env: BASE_URL (default http://localhost:8997), SHOTS_USER/SHOTS_PASS
// (default admin/changeme). Playwright is resolved from node_modules if
// installed, else the npx cache — `npx playwright install chromium` once.
import { chromium } from './lib/pw.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE_URL || 'http://localhost:8997';
const OUT = process.env.SHOTS_OUT || path.join(ROOT, 'docs', 'screenshots');
const USER = process.env.SHOTS_USER || 'admin';
const PASS = process.env.SHOTS_PASS || 'changeme';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const res = await page.request.post(BASE + '/api/login', { data: { handle: USER, password: PASS } });
if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
const { token } = await res.json();
await page.addInitScript(t => { globalThis.localStorage.mp_token = t; }, token);

// The only public page — taken before the token could matter anyway.
await page.goto(BASE + '/login.html');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/login.png` });
console.log('login');

const shot = async (name, url, wait = 800, fn) => {
    await page.goto(BASE + url);
    await page.waitForTimeout(wait);
    if (fn) { await fn(); await page.waitForTimeout(400); }
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name);
};

await shot('chat', '/index.html');
await shot('characters', '/characters.html');
await shot('world', '/world.html?id=1');
await shot('memories', '/memories.html?room=1', 1000);
await shot('stories', '/stories.html?room=1', 1000);
await shot('memsettings', '/memsettings.html', 1200);
await shot('connection', '/connection.html', 1000);
await browser.close();
console.log('done →', OUT);
