// Re-classify smart memories whose stored type looks wrong (e.g. everything
// tagged [fact] by a lazy extractor). Asks the LLM for the correct type per
// memory and writes it via memories/update.
//
// Usage: LIVE_TOKEN=<token> node scripts/retag-memories.mjs [roomId] [fromType]
//   roomId defaults to all rooms the token can see; fromType defaults to 'fact'.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.env.LIVE_URL || 'http://192.168.0.92:8100';
const TOKEN = process.env.LIVE_TOKEN;
if (!TOKEN) { console.error('LIVE_TOKEN required'); process.exit(1); }
const onlyRoom = process.argv[2] ? Number(process.argv[2]) : null;
const fromType = process.argv[3] || 'fact';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'app.db'));
const prof = db.prepare('SELECT * FROM api_profiles WHERE active=1 ORDER BY api_profiles_id_pk LIMIT 1').get();
if (!prof?.api_url) { console.error('no active api_profiles row in local data/app.db'); process.exit(1); }

const api = (p, b, method = 'POST') => fetch(`${LIVE}/api/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(method === 'POST' ? { body: JSON.stringify(b || {}) } : {}),
}).then(r => r.json());
const get = p => api(p, null, 'GET');

const { rooms } = await get('rooms');
const keyless = new Map();
for (const r of (rooms || []).filter(r => !onlyRoom || r.id === onlyRoom)) {
    const { memories } = await get(`memories?card=-1&room=${r.id}`);
    for (const m of memories || [])
        if (m.origin === 'smart' && m.type === fromType && !keyless.has(m.id)) keyless.set(m.id, m);
}
const items = [...keyless.values()];
console.log(`${items.length} '${fromType}' memories to re-classify`);
if (!items.length) process.exit(0);

const TYPES = 'event|relationship|preference|fact';
const BATCH = 25;
for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const listing = batch.map((m, j) => `${j + 1}. ${m.content}`).join('\n');
    const resp = await fetch(`${prof.api_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(prof.key ? { Authorization: `Bearer ${prof.key}` } : {}) },
        body: JSON.stringify({
            model: prof.model || 'local',
            messages: [
                { role: 'system', content: `Classify each roleplay memory into exactly one type: event (something that happened), relationship (feelings between characters), preference (likes/dislikes), fact (static truths only — identity, possessions, rules; LAST RESORT). Output ONLY a JSON array same order: [{"n":1,"t":"event"}]. No prose.` },
                { role: 'user', content: listing },
            ],
            temperature: 0.1, max_tokens: 8000, // reasoning models need headroom
        }),
    });
    if (!resp.ok) { console.error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`); process.exit(1); }
    const text = (await resp.json())?.choices?.[0]?.message?.content?.trim() || '';
    const jm = text.match(/\[[\s\S]*\]/);
    let parsed = [];
    try { parsed = jm ? JSON.parse(jm[0]) : []; } catch { parsed = []; }
    const byN = new Map(parsed.filter(o => o && o.n).map(o => [Number(o.n), String(o.t || o.type || '').toLowerCase()]));
    if (!byN.size) for (const l of text.split('\n')) {
        const m = l.match(/^\s*(\d+)[.)]\s*\[?(${TYPES})\]?/i);
        if (m) byN.set(Number(m[1]), m[2].toLowerCase());
    }
    for (const [j, m] of batch.entries()) {
        const t = byN.get(j + 1);
        if (!t || !new RegExp(`^(${TYPES})$`).test(t)) { console.log(`  #${m.id} — unparseable, skipped`); continue; }
        if (t === m.type) { console.log(`  #${m.id} — stays ${t}`); continue; }
        await api('memories/update', { id: m.id, type: t });
        console.log(`  #${m.id} ${m.type} → ${t}`);
    }
}
console.log('done');
