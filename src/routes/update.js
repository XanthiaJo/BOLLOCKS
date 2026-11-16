// Update check for the sidebar version badge: compares the running version
// against GitHub releases for the chosen channel. Nightly = latest commit on
// dev (the badge can't know what "installed" means for a git pull — it just
// reports the dev tip against the running SHA). GitHub API base/repo are
// overridable via env so tests can point them at a local mock.
import { send } from '../lib/util.js';
import { VERSION, SHA } from '../lib/version.js';

const REPO = process.env.BOLLOCKS_REPO || 'XanthiaJo/BOLLOCKS';
const GH = process.env.BOLLOCKS_GH_API || 'https://api.github.com';
const CHANNELS = ['stable', 'beta', 'nightly'];
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
};
