// Update-check route against a mock GitHub API (BOLLOCKS_GH_API).
// stable = latest release, beta = newest vX.Y.Z-beta.N prerelease,
// nightly = latest dev commit compared against the running build's sha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { boot, tmp, pub } from './helpers.js';
import { cmpVersion } from '../src/routes/update.js';

const RUNNING_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Minimal GitHub API stand-in: canned payloads per path family.
function mockGH({ latest = null, releases = [], commits = [] } = {}) {
    const srv = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/releases/latest')) {
            if (!latest) { res.statusCode = 404; return res.end('{}'); }
            return res.end(JSON.stringify(latest));
        }
        if (req.url.includes('/releases?')) return res.end(JSON.stringify(releases));
        if (req.url.includes('/commits')) return res.end(JSON.stringify(commits));
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise(r => srv.close(r)),
    })));
}

const rel = (tag, prerelease = false) => ({
    tag_name: tag, prerelease,
    html_url: `https://github.com/x/r/releases/tag/${tag}`,
    published_at: '2026-01-01T00:00:00Z',
});
const commit = (sha, message = 'feat: latest dev commit') => ({
    sha, html_url: `https://github.com/x/r/commit/${sha}`, commit: { message },
});

test('cmpVersion orders releases and prereleases correctly', () => {
    assert.equal(cmpVersion('v0.1.0', '0.1.0'), 0);
    assert.ok(cmpVersion('0.2.0', '0.1.9') > 0);
    assert.ok(cmpVersion('0.1.0', '0.2.0') < 0);
    // stable beats any prerelease of the same numbers, beta.3 beats beta.2
    assert.ok(cmpVersion('0.2.0', '0.2.0-beta.9') > 0);
    assert.ok(cmpVersion('0.2.0-beta.3', '0.2.0-beta.2') > 0);
    assert.ok(cmpVersion('0.2.0-beta.2', '0.2.0-beta.10') < 0);
    assert.ok(cmpVersion('0.2.0-beta.1', '0.2.0-alpha.1') > 0);
});

test('stable channel: newer release reported as an update', async () => {
    const gh = await mockGH({ latest: rel('v9.9.9') });
    const s = await boot(tmp('update-stable'), { BOLLOCKS_GH_API: gh.url });
    try {
        await s.login('admin');
        const r = await s.get('update?channel=stable');
        assert.equal(r.status, 200);
        assert.equal(r.json.channel, 'stable');
        assert.equal(r.json.latest.tag, 'v9.9.9');
        assert.equal(r.json.update, true);
        assert.equal(r.json.current.version, RUNNING_VERSION);
    } finally { await s.stop(); await gh.close(); }
});

test('stable channel: no release yet → latest null, not an update', async () => {
    const gh = await mockGH({});
    const s = await boot(tmp('update-stable-404'), { BOLLOCKS_GH_API: gh.url });
    try {
        await s.login('admin');
        const r = await s.get('update?channel=stable');
        assert.equal(r.status, 200);
        assert.equal(r.json.latest, null);
        assert.equal(r.json.update, false);
    } finally { await s.stop(); await gh.close(); }
});

test('beta channel: picks the newest -beta.N prerelease only', async () => {
    const gh = await mockGH({ releases: [rel('v0.3.0-beta.2', true), rel('v0.2.0'), rel('v0.3.0-alpha.1', true)] });
    const s = await boot(tmp('update-beta'), { BOLLOCKS_GH_API: gh.url });
    try {
        await s.login('admin');
        const r = await s.get('update?channel=beta');
        assert.equal(r.status, 200);
        assert.equal(r.json.latest.tag, 'v0.3.0-beta.2');
        assert.equal(r.json.update, true);
    } finally { await s.stop(); await gh.close(); }
});

test('nightly channel: dev tip compared against the running sha', async () => {
    const gh = await mockGH({ commits: [commit('a'.repeat(40))] });
    const s = await boot(tmp('update-nightly'), { BOLLOCKS_GH_API: gh.url });
    try {
        await s.login('admin');
        const r = await s.get('update?channel=nightly');
        assert.equal(r.status, 200);
        assert.equal(r.json.latest.sha, 'aaaaaaa');
        assert.equal(r.json.latest.message, 'feat: latest dev commit');
        // The running build's sha (if any) differs from the mock's → update.
        assert.equal(r.json.update, r.json.current.sha ? true : null);
    } finally { await s.stop(); await gh.close(); }
});

test('unknown channel falls back to stable; unauthenticated requests are 401', async () => {
    const gh = await mockGH({ latest: rel('v1.0.0') });
    const s = await boot(tmp('update-gate'), { BOLLOCKS_GH_API: gh.url });
    try {
        await s.login('admin');
        const r = await s.get('update?channel=bogus');
        assert.equal(r.json.channel, 'stable');
        const p = pub(s);
        assert.equal((await p.get('update?channel=stable')).status, 401);
    } finally { await s.stop(); await gh.close(); }
});
