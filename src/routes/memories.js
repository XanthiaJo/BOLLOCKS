// Memory routes: list/create/update/delete/triggers/move + lastmem.
// Trigger keywords live in memory_triggers (one row per word); the API
// keeps speaking comma-separated strings at the boundary.
const TRIG_SQL = `(SELECT GROUP_CONCAT(mt.word,',') FROM memory_triggers mt WHERE mt.memories_id_fk=m.memories_id_pk)`;
function setTriggers(id, str) {
    db.prepare('DELETE FROM memory_triggers WHERE memories_id_fk=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO memory_triggers (memories_id_fk,word) VALUES (?,?)');
    for (const w of (str || '').split(',')) { const word = w.trim().toLowerCase(); if (word) ins.run(id, word); }
}
import { db } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { roomMember, memoryShared } from '../lib/access.js';
import { consolidateArc } from '../generate.js';
import { dedupeRoom } from '../lib/memdedupe.js';

const MEMROW = 'SELECT memories_id_pk,created,superseded_by_memories_id_fk FROM memories WHERE memories_id_pk=?';
// Follow superseded_by to the chain head — a live row (null) or a
// self-referencing tombstone. Cycle-guarded like the UI's headOf.
function chainHead(m) {
    const row = db.prepare(MEMROW), seen = new Set(); let cur = m;
    while (cur.superseded_by_memories_id_fk && cur.superseded_by_memories_id_fk !== cur.memories_id_pk && !seen.has(cur.memories_id_pk)) {
        seen.add(cur.memories_id_pk);
        cur = row.get(cur.superseded_by_memories_id_fk);
    }
    return cur;
}

export default {
    'GET /api/lastmem': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room')) || 1;
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        send(res, 200, db.prepare("SELECT m.content text FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.superseded_by_memories_id_fk IS NULL ORDER BY m.memories_id_pk DESC LIMIT 1").get(roomId) || null);
    },
    'GET /api/memories': async (req, res, u) => {
        const q = new URL(req.url, 'http://x').searchParams;
        const card = Number(q.get('card') ?? -1);
        const room = Number(q.get('room') || 0);
        if (!roomMember(room, u)) return send(res, 403, { error: 'not a room member' });
        const rows = db.prepare(`SELECT m.*, ${TRIG_SQL} AS triggers, m.memories_id_pk AS id, c.name card_name, r.name room_name, mc.cards_id_fk AS cards_id_fk FROM memories m
            JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
            LEFT JOIN memory_cards mc ON mc.memories_id_fk=m.memories_id_pk
            LEFT JOIN cards c ON c.cards_id_pk=mc.cards_id_fk JOIN rooms r ON r.rooms_id_pk=rm.rooms_id_fk
            WHERE (?<0 OR (?=0 AND mc.memories_id_fk IS NULL) OR mc.cards_id_fk=?)
              AND (?=0 OR rm.rooms_id_fk=?) ORDER BY m.memories_id_pk`)
            .all(card, card, card, room, room);
        send(res, 200, { memories: rows });
    },
    'POST /api/memories': async (req, res, u) => {
        const b = await readBody(req);
        if (!roomMember(b.room || 1, u)) return send(res, 403, { error: 'not a room member' });
        const id = db.prepare('INSERT INTO memories (content,type,origin) VALUES (?,?,?)')
            .run(b.content || '', b.type || 'fact', 'user').lastInsertRowid;
        setTriggers(id, b.triggers);
        db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(b.room || 1, id);
        if (b.cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, b.cardId);
        send(res, 200, { id });
    },
    'POST /api/memories/update': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!db.prepare('SELECT 1 FROM memories WHERE memories_id_pk=?').get(id)) return send(res, 404, { error: 'no memory' });
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
        const origin = b.origin === 'smart' || b.origin === 'user' ? b.origin : null;
        // Card-scoped smart memories are not supported yet.
        if (origin === 'smart' && db.prepare('SELECT 1 FROM memory_cards WHERE memories_id_fk=?').get(id))
            return send(res, 400, { error: 'character smart memories not supported yet' });
        db.prepare('UPDATE memories SET content=COALESCE(?,content), type=COALESCE(?,type), origin=COALESCE(?,origin) WHERE memories_id_pk=?')
            .run(b.content ?? null, b.type ?? null, origin, id);
        if (b.triggers !== undefined) setTriggers(id, b.triggers);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
        // chain=1 also deletes every version this row superseded (walk
        // superseded_by backwards). A plain delete leaves history, and the
        // ON DELETE SET NULL FK revives the previous version as current.
        const ids = new Set([id]);
        if (b.chain) {
            const pred = db.prepare('SELECT memories_id_pk FROM memories WHERE superseded_by_memories_id_fk=?');
            for (const cid of ids) for (const r of pred.all(cid)) ids.add(r.memories_id_pk);
        }
        db.exec('BEGIN');
        try {
            for (const cid of ids) {
                db.prepare('DELETE FROM room_memories WHERE memories_id_fk=?').run(cid);
                db.prepare('DELETE FROM memory_cards WHERE memories_id_fk=?').run(cid);
                db.prepare('DELETE FROM memory_triggers WHERE memories_id_fk=?').run(cid);
                db.prepare('DELETE FROM memories WHERE memories_id_pk=?').run(cid);
            }
            db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        send(res, 200, { ok: true });
    },
    // Manual retelling sweep — same check extraction runs on each new
    // memory, applied pairwise across the room's live smart events.
    // Returns [[oldId, newId], ...] pairs it chained.
    'POST /api/memories/dedupe': async (req, res, u) => {
        const b = await readBody(req);
        if (!roomMember(b.room || 1, u)) return send(res, 403, { error: 'not a room member' });
        send(res, 200, { merged: dedupeRoom(b.room || 1) });
    },
    // Drag-link: merge two chains into one — the head with the newest
    // `created` stays live, the other head supersede-points at it.
    'POST /api/memories/link': async (req, res, u) => {
        const b = await readBody(req);
        const row = db.prepare(MEMROW);
        const a = row.get(b.id), t = row.get(b.target);
        if (!a || !t) return send(res, 404, { error: 'no memory' });
        if (!memoryShared(b.id, u) || !memoryShared(b.target, u)) return send(res, 403, { error: 'not a room member' });
        const ha = chainHead(a), ht = chainHead(t);
        if (ha.memories_id_pk === ht.memories_id_pk) return send(res, 200, { ok: true, head: ha.memories_id_pk });
        if (ha.superseded_by_memories_id_fk === ha.memories_id_pk || ht.superseded_by_memories_id_fk === ht.memories_id_pk)
            return send(res, 400, { error: 'retracted rows cannot be linked' });
        const newer = (ha.created === ht.created ? ha.memories_id_pk > ht.memories_id_pk : ha.created > ht.created) ? ha : ht;
        const older = newer === ha ? ht : ha;
        db.prepare('UPDATE memories SET superseded_by_memories_id_fk=?, user_sorted=1 WHERE memories_id_pk=?').run(newer.memories_id_pk, older.memories_id_pk);
        db.prepare('UPDATE memories SET user_sorted=1 WHERE memories_id_pk=?').run(newer.memories_id_pk);
        send(res, 200, { ok: true, head: newer.memories_id_pk });
    },
    // Drag-out: detach a superseded row — clears its supersede pointer so
    // it stands alone as a live head again (its own drafts stay attached).
    // With `target`, the row instead re-points under target's chain head.
    'POST /api/memories/unlink': async (req, res, u) => {
        const b = await readBody(req);
        const row = db.prepare(MEMROW);
        const m = row.get(b.id);
        if (!m) return send(res, 404, { error: 'no memory' });
        if (!memoryShared(b.id, u)) return send(res, 403, { error: 'not a room member' });
        if (m.superseded_by_memories_id_fk === m.memories_id_pk)
            return send(res, 400, { error: 'retracted rows cannot be unlinked' });
        let next = null;
        if (b.target) {
            const t = row.get(b.target);
            if (!t) return send(res, 404, { error: 'no memory' });
            if (!memoryShared(b.target, u)) return send(res, 403, { error: 'not a room member' });
            const ht = chainHead(t);
            if (ht.superseded_by_memories_id_fk === ht.memories_id_pk)
                return send(res, 400, { error: 'retracted rows cannot be linked' });
            if (ht.memories_id_pk === m.memories_id_pk) return send(res, 200, { ok: true });
            next = ht.memories_id_pk;
            db.prepare('UPDATE memories SET user_sorted=1 WHERE memories_id_pk=?').run(next);
        }
        db.prepare('UPDATE memories SET superseded_by_memories_id_fk=?, user_sorted=1 WHERE memories_id_pk=?').run(next, m.memories_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/triggers': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
    setTriggers(id, b.triggers);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/move': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
        // Card-scoped smart memories are not supported yet.
        if (b.cardId && db.prepare("SELECT 1 FROM memories WHERE memories_id_pk=? AND origin='smart'").get(id))
            return send(res, 400, { error: 'character smart memories not supported yet' });
    db.prepare('DELETE FROM memory_cards WHERE memories_id_fk=?').run(id);
    if (b.cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, b.cardId);
        send(res, 200, { ok: true });
    },
    // Story arcs: room-scoped open threads, user-managed via these routes
    // and AI-managed via [arc*] extraction tags.
    'GET /api/arcs': async (req, res, u) => {
        const room = Number(new URL(req.url, 'http://x').searchParams.get('room') || 0);
        if (!roomMember(room, u)) return send(res, 403, { error: 'not a room member' });
        const arcs = db.prepare(`SELECT room_arcs_id_pk AS id, title, summary, status, origin, created, updated,
            opened_messages_id_fk AS openedId, closed_messages_id_fk AS closedId
            FROM room_arcs WHERE rooms_id_fk=? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated DESC`).all(room);
        // Extractions folded under each arc at close — the thread's detail
        // history, expandable in the Stories UI.
        const folded = db.prepare(`SELECT m.memories_id_pk AS id, m.type, m.content, m.created,
                m.superseded_by_memories_id_fk AS sup, ${TRIG_SQL} AS triggers, m.room_arcs_id_fk AS arcId
            FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
            WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NOT NULL ORDER BY m.memories_id_pk`).all(room);
        const byArc = {};
        for (const f of folded) (byArc[f.arcId] ||= []).push(f);
        send(res, 200, { arcs: arcs.map(a => ({ ...a, mems: byArc[a.id] || [] })) });
    },
    'POST /api/arcs': async (req, res, u) => {
        const b = await readBody(req);
        if (!roomMember(b.room || 1, u)) return send(res, 403, { error: 'not a room member' });
        if (!b.title?.trim()) return send(res, 400, { error: 'title required' });
        const id = db.prepare('INSERT INTO room_arcs (rooms_id_fk,title,summary) VALUES (?,?,?)')
            .run(b.room || 1, b.title.trim(), b.summary || '').lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/arcs/update': async (req, res, u) => {
        const b = await readBody(req);
        const arc = db.prepare('SELECT rooms_id_fk, status FROM room_arcs WHERE room_arcs_id_pk=?').get(b.id);
        if (!arc) return send(res, 404, { error: 'no arc' });
        if (!roomMember(arc.rooms_id_fk, u)) return send(res, 403, { error: 'not a room member' });
        const status = ['open', 'resolved', 'dropped'].includes(b.status) ? b.status : null;
        // Reopening re-anchors the span: opened resets to the latest
        // message and the stale close clears, so a second consolidation
        // covers only the continuation — not everything since the first
        // open (which would re-sweep unrelated memories into the arc).
        db.prepare(`UPDATE room_arcs SET title=COALESCE(NULLIF(?,''),title), summary=COALESCE(?,summary),
            status=COALESCE(?,status), updated=datetime('now'),
            closed_messages_id_fk=CASE WHEN ?='open' AND status<>'open' THEN NULL
                WHEN ? IN ('resolved','dropped') AND status='open'
                THEN (SELECT MAX(messages_id_pk) FROM messages WHERE rooms_id_fk=?) ELSE closed_messages_id_fk END,
            opened_messages_id_fk=CASE WHEN ?='open' AND status<>'open'
                THEN (SELECT MAX(messages_id_pk) FROM messages WHERE rooms_id_fk=?) ELSE opened_messages_id_fk END
            WHERE room_arcs_id_pk=?`)
            .run(b.title?.trim() ?? null, b.summary ?? null, status, status, status, arc.rooms_id_fk, status, arc.rooms_id_fk, b.id);
        if (status && status !== 'open' && arc.status === 'open')
            consolidateArc(arc.rooms_id_fk, b.id).catch(e => console.error('[mem]', e.message));
        send(res, 200, { ok: true });
    },
    'POST /api/arcs/resolve': async (req, res, u) => {
        const b = await readBody(req);
        const arc = db.prepare('SELECT rooms_id_fk, status FROM room_arcs WHERE room_arcs_id_pk=?').get(b.id);
        if (!arc) return send(res, 404, { error: 'no arc' });
        if (!roomMember(arc.rooms_id_fk, u)) return send(res, 403, { error: 'not a room member' });
        db.prepare(`UPDATE room_arcs SET status='resolved', updated=datetime('now'),
            closed_messages_id_fk=(SELECT MAX(messages_id_pk) FROM messages WHERE rooms_id_fk=?) WHERE room_arcs_id_pk=?`)
            .run(arc.rooms_id_fk, b.id);
        if (arc.status === 'open')
            consolidateArc(arc.rooms_id_fk, b.id).catch(e => console.error('[mem]', e.message));
        send(res, 200, { ok: true });
    },
    'POST /api/arcs/delete': async (req, res, u) => {
        const b = await readBody(req);
        const arc = db.prepare('SELECT rooms_id_fk FROM room_arcs WHERE room_arcs_id_pk=?').get(b.id);
        if (!arc) return send(res, 404, { error: 'no arc' });
        if (!roomMember(arc.rooms_id_fk, u)) return send(res, 403, { error: 'not a room member' });
        db.prepare('DELETE FROM room_arcs WHERE room_arcs_id_pk=?').run(b.id);
        send(res, 200, { ok: true });
    },
};
