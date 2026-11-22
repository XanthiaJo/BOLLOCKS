// Playwright resolver: prefer an installed package, fall back to the
// newest playwright in the npx cache (npx playwright install works
// without a project dependency).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

async function load() {
    try { return await import('playwright'); } catch { /* not installed */ }
    const npx = path.join(os.homedir(), '.npm', '_npx');
    if (fs.existsSync(npx)) {
        const hits = fs.readdirSync(npx)
            .map(d => path.join(npx, d, 'node_modules', 'playwright', 'index.mjs'))
            .filter(fs.existsSync);
        if (hits.length) return import(hits[0]);
    }
    // Global installs (npm -g) as last resort
    try {
        const req = createRequire(import.meta.url);
        return req('playwright');
    } catch { /* fall through */ }
    throw new Error('playwright not found — run `npm i -D playwright` or `npx playwright install chromium`');
}
export const { chromium } = await load();
