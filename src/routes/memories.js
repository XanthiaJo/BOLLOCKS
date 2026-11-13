// Memory routes: list/create/update/delete/triggers/move + lastmem.
import { db } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { roomMember, memoryShared } from '../lib/access.js';

export default {
    'GET /api/lastmem': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room')) || 1;
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        send(res, 200, db.prepare("SELECT m.content text FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart' ORDER BY m.memories_id_pk DESC LIMIT 1").get(roomId) || null);
    },
    'GET /api/memories': async (req, res, u) => {
        const q = new URL(req.url, 'http://x').searchParams;
        const card = Number(q.get('card') ?? -1);
        const room = Number(q.get('room') || 0);
        if (!roomMember(room, u)) return send(res, 403, { error: 'not a room member' });
        const rows = db.prepare(`SELECT m.*, m.memories_id_pk AS id, c.name card_name, r.name room_name, mc.cards_id_fk AS cards_id_fk FROM memories m
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
        const id = db.prepare('INSERT INTO memories (content,type,origin,triggers) VALUES (?,?,?,?)')
            .run(b.content || '', b.type || 'fact', 'user', b.triggers || '').lastInsertRowid;
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
        db.prepare('UPDATE memories SET content=COALESCE(?,content), type=COALESCE(?,type), triggers=COALESCE(?,triggers), origin=COALESCE(?,origin) WHERE memories_id_pk=?')
            .run(b.content ?? null, b.type ?? null, b.triggers ?? null, origin, id);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
    db.prepare('DELETE FROM room_memories WHERE memories_id_fk=?').run(id);
    db.prepare('DELETE FROM memory_cards WHERE memories_id_fk=?').run(id);
    db.prepare('DELETE FROM memories WHERE memories_id_pk=?').run(id);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/triggers': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!memoryShared(id, u)) return send(res, 403, { error: 'not a room member' });
    db.prepare('UPDATE memories SET triggers=? WHERE memories_id_pk=?').run(b.triggers || '', id);
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
};
