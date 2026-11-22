import { db } from '../db.js';

// Retelling detection: extraction tends to re-summarize the same ongoing
// event every pass, piling up near-duplicate rows. When a new event
// substantially retells a still-live one the script supersedes the older
// row itself — the writer only had to write it, [supersede N] or not.
// Match strength is IDF-weighted trigger overlap (overlap coefficient):
// shared rare words weigh far more than ubiquitous in-room vocabulary
// like character names. Threshold errs conservative — a retelling whose
// trigger vocabulary the model fully paraphrases scores like a distinct
// event and is left for the writer's own [supersede] judgment rather
// than risking a wrong merge.
const STOP = new Set('a an the was is were been be on of in at to by with and or for from under over his her their its it as that this into out up down'.split(' '));
// Strip possessives first ('rabbit's' → 'rabbit') or the leftover 's'
// fragment becomes a junk token shared across rows, inflating overlap.
// Single-char tokens are dropped for the same reason.
const words = s => new Set((s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)));

const DEDUPE_MIN = 0.3; // weighted overlap coefficient to call a retelling

// `arc` = 'live' → standalone smart events (not folded); a number → smart
// events folded under that arc. Either way only un-retired rows enter:
// an already-superseded row is settled history, never a candidate.
function eventRows(roomId, arc = 'live') {
    const where = (arc === 'live' ? 'm.room_arcs_id_fk IS NULL' : 'm.room_arcs_id_fk=' + Number(arc))
        + ' AND m.superseded_by_memories_id_fk IS NULL';
    return db.prepare(`SELECT m.memories_id_pk AS id,
        (SELECT GROUP_CONCAT(mt.word,' ') FROM memory_triggers mt WHERE mt.memories_id_fk=m.memories_id_pk) AS trigs
        FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type='event' AND ${where}
        ORDER BY m.memories_id_pk`).all(roomId);
}

// IDF-weighted overlap scorer over a row set's trigger corpus.
function scorer(rows) {
    const df = {};
    for (const r of rows) { r.tw = words((r.trigs || '').replace(/,/g, ' ')); for (const w of r.tw) df[w] = (df[w] || 0) + 1; }
    const idf = w => Math.log(1 + rows.length / (df[w] || 1));
    return (a, b) => {
        let inter = 0, sa = 0, sb = 0;
        for (const w of a.tw) { const x = idf(w); sa += x; if (b.tw.has(w)) inter += x; }
        for (const w of b.tw) sb += idf(w);
        const den = Math.min(sa, sb);
        return den ? inter / den : 0;
    };
}

const mark = () => db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?');

// Pairwise chain over a row set, newest wins: each row retires the
// earlier rows it retells (rows just superseded stop being candidates).
function sweep(rows, score) {
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

// Freshly inserted memory `newId` retires every still-live same-room event
// it substantially retells. Folded rows stay out — a new extraction must
// not rewrite a sealed story's history. Returns the superseded ids ([]
// when the new row isn't a triggered room event itself).
export function dedupeNew(roomId, newId) {
    const rows = eventRows(roomId);
    const score = scorer(rows);
    const me = rows.find(r => r.id === newId);
    if (!me || !me.tw.size) return [];
    const upd = mark();
    return rows.filter(r => r.id !== newId && score(r, me) >= DEDUPE_MIN)
        .map(r => (upd.run(newId, r.id), r.id));
}

// Retroactive sweep: chains retellings in the live set and, separately,
// inside each arc's folded set (beats of one story chain under their
// newest telling). Each pass runs to fixpoint: a merge shrinks the live
// corpus, which shifts every IDF weight — pairs that scored under the
// threshold can cross it once merged rows leave the set.
// Returns [[oldId, newId], ...] pairs for reporting.
export function dedupeRoom(roomId) {
    const merged = [];
    const sweepSet = arc => {
        let pass;
        do {
            const rows = eventRows(roomId, arc);
            pass = sweep(rows, scorer(rows));
            merged.push(...pass);
        } while (pass.length);
    };
    sweepSet('live');
    const arcIds = db.prepare(`SELECT DISTINCT m.room_arcs_id_fk AS id
        FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NOT NULL`).all(roomId);
    for (const { id } of arcIds) sweepSet(id);
    return merged;
}
