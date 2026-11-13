// Backfill trigger keywords for memories that have none.
// Memories without triggers are injected into EVERY prompt; triggers make
// them fire only when relevant recent chat mentions a keyword.
//
// Usage:
//   LIVE_TOKEN=<session token> node scripts/backfill-triggers.mjs [roomId]
//   LIVE_URL=http://192.168.0.92:8100 LIVE_TOKEN=... node scripts/backfill-triggers.mjs
//
// The LLM call uses the local dev DB's first active api_profiles row
// (any working OpenAI-compatible endpoint will do).

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.env.LIVE_URL || 'http://192.168.0.92:8100';
const TOKEN = process.env.LIVE_TOKEN;
if (!TOKEN) { console.error('LIVE_TOKEN required'); process.exit(1); }
const onlyRoom = process.argv[2] ? Number(process.argv[2]) : null;

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

// Collect memories with empty triggers across rooms (card=-1 returns all scopes).
const { rooms } = await get('rooms');
const targets = (rooms || []).filter(r => !onlyRoom || r.id === onlyRoom);
const keyless = new Map(); // id -> memory
for (const r of targets) {
    const { memories } = await get(`memories?card=-1&room=${r.id}`);
    for (const m of memories || []) {
        if (!(m.triggers || '').trim() && !keyless.has(m.id)) keyless.set(m.id, m);
    }
}
console.log(`${keyless.size} memories without triggers`);
if (!keyless.size) process.exit(0);

// Ask the LLM for trigger keywords, batched to keep prompts small.
const items = [...keyless.values()];
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
                { role: 'system', content: 'You assign trigger keywords to roleplay memories. Output ONLY a JSON array, one object per input line, same order: [{"n":1,"k":"word, word, word"}] — 2-5 lowercase keywords per memory that would appear in chat when it is relevant (names, places, objects, topics). No prose, no markdown fences.' },
                { role: 'user', content: listing },
            ],
            temperature: 0.2, max_tokens: 2000,
        }),
    });
    if (!resp.ok) { console.error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`); process.exit(1); }
    const text = (await resp.json())?.choices?.[0]?.message?.content?.trim() || '';
    // Lenient JSON extraction — models sometimes wrap in fences or add prose.
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    let parsed = [];
    try { parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : []; } catch { parsed = []; }
    const byN = new Map(parsed.filter(o => o && o.n).map(o => [Number(o.n), o.k || o.triggers || '']));
    // Fallback: "n. word, word" lines if JSON parsing failed entirely.
    if (!byN.size) {
        for (const l of text.split('\n')) {
            const m = l.match(/^\s*(\d+)[.)]\s*(.+)$/);
            if (m) byN.set(Number(m[1]), m[2]);
        }
    }
    for (const [j, m] of batch.entries()) {
        const n = j + 1;
        const triggers = String(byN.get(n) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 6).join(',');
        if (!triggers) { console.log(`  #${m.id} — no keywords parsed, skipped`); continue; }
        await api('memories/update', { id: m.id, triggers });
        console.log(`  #${m.id} → ${triggers}`);
    }
}
console.log('done');
