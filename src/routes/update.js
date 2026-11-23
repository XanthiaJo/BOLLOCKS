// Update check for the sidebar version badge: compares the running version
// against GitHub releases for the chosen channel. Nightly = latest commit on
// dev (the badge can't know what "installed" means for a git pull — it just
// reports the dev tip against the running SHA). GitHub API base/repo are
// overridable via env so tests can point them at a local mock.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { send, readBody } from '../lib/util.js';
import { isAdmin } from '../lib/access.js';
import { PUB } from '../lib/files.js';
import { VERSION, SHA } from '../lib/version.js';

const REPO = process.env.BOLLOCKS_REPO || 'XanthiaJo/BOLLOCKS';
const GH = process.env.BOLLOCKS_GH_API || 'https://api.github.com';
const CHANNELS = ['stable', 'beta', 'nightly'];
// Which ref each channel pulls: stable tracks master, beta the beta branch,
// nightly dev. Only these fixed names are ever passed to git.
const BRANCHES = { stable: 'master', beta: 'beta', nightly: 'dev' };
const TTL = 5 * 60 * 1000; // anonymous GitHub rate limit is 60/h per IP
const cache = new Map();

/** GET a GitHub API path (cached briefly). 404 → null, other errors throw. */
async function gh(pathname) {
    const hit = cache.get(pathname);
    if (hit && Date.now() - hit.at < TTL) return hit.data;
    const r = await fetch(`${GH}/repos/${REPO}/${pathname}`, {
        headers: { 'User-Agent': 'BOLLOCKS', Accept: 'application/vnd.github+json' },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${pathname}: HTTP ${r.status}`);
    const data = await r.json();
    cache.set(pathname, { at: Date.now(), data });
    return data;
}

// Numeric semver compare with prerelease handling: 0.2.0 > 0.2.0-beta.2 and
// beta.3 > beta.2. Negative if a < b, 0 if equal.
export function cmpVersion(a, b) {
    const [va, pa] = a.replace(/^v/, '').split('-');
    const [vb, pb] = b.replace(/^v/, '').split('-');
    const nums = s => s.split('.').map(Number);
    const [na, nb] = [nums(va), nums(vb)];
    for (let i = 0; i < 3; i++) if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    // Same numbers: a stable release beats any prerelease of it.
    if (!!pa !== !!pb) return pa ? -1 : 1;
    if (!pa) return 0;
    const [xa, xb] = [pa.split('.'), pb.split('.')];
    for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
        if (xa[i] === xb[i]) continue;
        if (xa[i] === undefined) return 1;
        if (xb[i] === undefined) return -1;
        const d = Number(xa[i]) - Number(xb[i]);
        if (Number.isNaN(d)) return xa[i] < xb[i] ? -1 : 1; // non-numeric suffixes: lexical
        if (d) return d;
    }
    return 0;
}

export default {
    'GET /api/update': async (req, res) => {
        const q = new URL(req.url, 'http://x').searchParams;
        const channel = CHANNELS.includes(q.get('channel')) ? q.get('channel') : 'stable';
        const current = { version: VERSION, sha: SHA || null };
        try {
            let latest = null, update = false;
            if (channel === 'nightly') {
                const [c] = await gh('commits?sha=dev&per_page=1') || [];
                if (c) {
                    latest = { sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], url: c.html_url };
                    // update: true/false, or null when the running build has no SHA to compare.
                    update = SHA ? latest.sha !== SHA.slice(0, 7) : null;
                }
            } else if (channel === 'stable') {
                const r = await gh('releases/latest');
                if (r) {
                    latest = { tag: r.tag_name, url: r.html_url, published: r.published_at };
                    update = cmpVersion(r.tag_name, VERSION) > 0;
                }
            } else {
                const rels = await gh('releases?per_page=30') || [];
                const r = rels.find(x => x.prerelease && /-beta\.\d+$/.test(x.tag_name));
                if (r) {
                    latest = { tag: r.tag_name, url: r.html_url, published: r.published_at };
                    update = cmpVersion(r.tag_name, VERSION) > 0;
                }
            }
            send(res, 200, { channel, current, latest, update });
        } catch (e) {
            send(res, 502, { error: `update check failed: ${e?.message || e}` });
        }
    },

    // Admin-only: fast-forward the checkout to the chosen channel's ref and
    // restart so the pulled code takes over. Refuses a dirty working tree —
    // checkout -B + fetch are safe only when nothing local is at risk.
    'POST /api/update/pull': async (req, res, u) => {
        const b = await readBody(req);
        const channel = CHANNELS.includes(b.channel) ? b.channel : '';
        if (!channel) return send(res, 400, { error: 'channel must be stable, beta or nightly' });
        if (!isAdmin(u)) return send(res, 403, { error: 'admin only' });
        const root = path.join(PUB, '..');
        const branch = BRANCHES[channel];
        try {
            // Managed/container deploy — no checkout to pull. Overlay the
            // channel's tarball on the install root, stamp the resolved sha
            // for version.js, then exit: the supervisor (docker restart
            // policy, systemd, pm2) brings the new code up.
            if (!fs.existsSync(path.join(root, '.git'))) {
                const [c] = await gh(`commits?sha=${branch}&per_page=1`) || [];
                if (!c) return send(res, 404, { error: `no ${channel} ref on origin` });
                const sha = c.sha.slice(0, 7);
                const t = await fetch(`${GH}/repos/${REPO}/tarball/${branch}`, { headers: { 'User-Agent': 'BOLLOCKS' } });
                if (!t.ok) return send(res, 502, { error: `tarball fetch: HTTP ${t.status}` });
                execFileSync('tar', ['-xzf', '-', '--strip-components=1', '-C', root], { input: Buffer.from(await t.arrayBuffer()) });
                fs.writeFileSync(path.join(root, '.deploy-sha'), sha);
                send(res, 200, { ok: true, branch, sha });
                setTimeout(() => process.exit(0), 300);
                return;
            }
            const git = (...args) => execFileSync('git', args, { cwd: root }).toString().trim();
            if (git('status', '--porcelain')) return send(res, 409, { error: 'working tree not clean — refusing to update' });
            git('fetch', 'origin', branch);
            git('checkout', '-B', branch, `origin/${branch}`);
            const sha = git('rev-parse', '--short', 'HEAD');
            send(res, 200, { ok: true, branch, sha });
            // Self-restart: release the port, then respawn a detached twin so
            // the pulled code takes over — `npm start` shells need no
            // supervisor. Respond first; the client polls /api/version.
            setTimeout(() => {
                globalThis.mpServer?.close();
                spawn(process.execPath, ['src/server.js'], {
                    cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
                }).unref();
                setTimeout(() => process.exit(0), 500);
            }, 200);
        } catch (e) {
            send(res, 500, { error: `update failed: ${e?.message || e}` });
        }
    },
};
