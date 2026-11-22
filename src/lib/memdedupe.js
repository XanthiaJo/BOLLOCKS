import { db } from '../db.js';

// Retelling detection: extraction tends to re-summarize the same ongoing
// event every pass, piling up near-duplicate rows. When a new event
// substantially retells a still-live one the script supersedes the older
// row itself — the writer only had to write it, [supersede N] or not.
// Match strength is IDF-weighted trigger overlap (overlap coefficient):
// shared rare words weigh far more than ubiquitous in-room vocabulary
// like character names. Corpus-tuned: retellings score ~0.31-0.67 while
// distinct-but-related events cap ~0.27.
const STOP = new Set('a an the was is were been be on of in at to by with and or for from under over his her their its it as that this into out up down'.split(' '));
const words = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));

const DEDUPE_MIN = 0.3; // weighted overlap coefficient to call a retelling

// Live, smart, unfolded room events with their trigger word sets and an
// IDF-weighted scorer built over the room's whole event corpus.
function liveEvents(roomId) {
    const rows = db.prepare(`SELECT m.memories_id_pk AS id,
        (SELECT GROUP_CONCAT(mt.word,' ') FROM memory_triggers mt WHERE mt.memories_id_fk=m.memories_id_pk) AS trigs
        FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type='event'
          AND m.room_arcs_id_fk IS NULL AND m.superseded_by_memories_id_fk IS NULL
        ORDER BY m.memories_id_pk`).all(roomId);
    const df = {};
    for (const r of rows) { r.tw = words((r.trigs || '').replace(/,/g, ' ')); for (const w of r.tw) df[w] = (df[w] || 0) + 1; }
    const idf = w => Math.log(1 + rows.length / (df[w] || 1));
    const score = (a, b) => {
        let inter = 0, sa = 0, sb = 0;
        for (const w of a.tw) { const x = idf(w); sa += x; if (b.tw.has(w)) inter += x; }
        for (const w of b.tw) sb += idf(w);
        const den = Math.min(sa, sb);
        return den ? inter / den : 0;
    };
    return { rows, score };
}

const mark = () => db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?');

// Freshly inserted memory `newId` retires every still-live same-room event
// it substantially retells. Returns the superseded ids ([] when the new
// row isn't a triggered room event itself).
export function dedupeNew(roomId, newId) {
    const { rows, score } = liveEvents(roomId);
    const me = rows.find(r => r.id === newId);
    if (!me || !me.tw.size) return [];
    const upd = mark();
    return rows.filter(r => r.id !== newId && score(r, me) >= DEDUPE_MIN)
        .map(r => (upd.run(newId, r.id), r.id));
}

// Retroactive sweep: walk live events in id order; each retires its
// earlier retold matches (rows just superseded stop being candidates).
// Returns [[oldId, newId], ...] pairs for reporting.
export function dedupeRoom(roomId) {
    const { rows, score } = liveEvents(roomId);
    const live = new Set(rows.map(r => r.id));
    const upd = mark();
    const merged = [];
    for (let i = 0; i < rows.length; i++) {
        const cur = rows[i];
        if (!live.has(cur.id) || !cur.tw.size) continue;
        for (let j = 0; j < i; j++) {
            const old = rows[j];
            if (live.has(old.id) && score(old, cur) >= DEDUPE_MIN) {
                upd.run(cur.id, old.id);
                live.delete(old.id);
                merged.push([old.id, cur.id]);
            }
        }
    }
    return merged;
}
