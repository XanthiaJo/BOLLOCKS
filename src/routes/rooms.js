// Room routes: CRUD, membership, talkativeness, trigger/settings,
// memory profile, background image, and the room view itself.
import fs from 'node:fs';
import path from 'node:path';
import { db, MSG_SQL } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { roomOwnerOnly, roomMember } from '../lib/access.js';
import { BG_DIR } from '../lib/files.js';

export default {
    'POST /api/members': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (b.userId) {
            if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
            const pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(b.userId)?.cards_id_pk;
            if (!pc) return send(res, 400, { error: 'user has no persona card' });
            db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)').run(rid, pc);
            return send(res, 200, { ok: true });
        }
        // Members may seat a card they own; the room owner may seat any card.
        const card = db.prepare('SELECT owner_users_id_fk FROM cards WHERE cards_id_pk=?').get(b.cardId);
        if (!card) return send(res, 404, { error: 'card not found' });
        if (!roomOwnerOnly(rid, u)) {
            if (!roomMember(rid, u)) return send(res, 403, { error: 'not a room member' });
            if (card.owner_users_id_fk !== u.users_id_pk) return send(res, 403, { error: 'not your character' });
        }
        db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)').run(rid, b.cardId);
        send(res, 200, { ok: true });
    },
    'POST /api/members/remove': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || 1;
        if (!roomOwnerOnly(rid, u)) {
            // Non-owners may only remove themselves (their own persona/card).
            const ownCard = b.cardId && db.prepare('SELECT 1 FROM cards WHERE cards_id_pk=? AND owner_users_id_fk=?').get(b.cardId, u.users_id_pk);
            const ownPersona = !b.cardId && b.userId === u.users_id_pk;
            if (!ownCard && !ownPersona) return send(res, 403, { error: 'room owner only' });
        }
        if (b.cardId) db.prepare('DELETE FROM room_members WHERE rooms_id_fk=? AND cards_id_fk=?').run(b.room || 1, b.cardId);
        else if (b.userId) {
            const pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(b.userId)?.cards_id_pk;
            if (pc) db.prepare('DELETE FROM room_members WHERE rooms_id_fk=? AND cards_id_fk=?').run(b.room || 1, pc);
        }
        send(res, 200, { ok: true });
    },
    'GET /api/rooms': async (req, res, u) => {
        const rooms = db.prepare(`SELECT DISTINCT r.rooms_id_pk AS id, r.name, r.ai_trigger, r.max_context,
            r.mem_profiles_id_fk, r.owner_users_id_fk AS owner,
            (SELECT name FROM mem_profiles WHERE mem_profiles_id_pk=r.mem_profiles_id_fk) AS mem_profile_name,
            (SELECT auto_mem FROM mem_profiles WHERE mem_profiles_id_pk=r.mem_profiles_id_fk) AS mem_profile_auto,
            (r.owner_users_id_fk=?) AS is_owner,
            (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.rooms_id_fk=r.rooms_id_pk) AS members, r.bg FROM rooms r
            JOIN room_members rm ON rm.rooms_id_fk=r.rooms_id_pk JOIN cards c ON c.cards_id_pk=rm.cards_id_fk WHERE c.owner_users_id_fk=? ORDER BY r.rooms_id_pk`).all(u.users_id_pk, u.users_id_pk);
        send(res, 200, { rooms });
    },
    'POST /api/rooms': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare(`INSERT INTO rooms (name,mem_profiles_id_fk,owner_users_id_fk) VALUES (?,(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1),?)`).run(b.name, u.users_id_pk).lastInsertRowid;
        const pc0 = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk)?.cards_id_pk;
        if (pc0) db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)').run(id, pc0);
        send(res, 200, { id, name: b.name });
    },
    'POST /api/rooms/update': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!roomOwnerOnly(id, u)) return send(res, 403, { error: 'room owner only' });
        if (b.name) db.prepare('UPDATE rooms SET name=? WHERE rooms_id_pk=?').run(b.name, id);
        send(res, 200, { ok: true });
    },
    'POST /api/rooms/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!roomOwnerOnly(id, u)) return send(res, 403, { error: 'room owner only' });
        db.prepare('DELETE FROM messages WHERE rooms_id_fk=?').run(id);
        db.prepare('DELETE FROM room_members WHERE rooms_id_fk=?').run(id);
        db.prepare('DELETE FROM memory_cards WHERE memories_id_fk IN (SELECT memories_id_fk FROM room_memories WHERE rooms_id_fk=?)').run(id);
        db.prepare('DELETE FROM memories WHERE memories_id_pk IN (SELECT memories_id_fk FROM room_memories WHERE rooms_id_fk=?)').run(id);
        db.prepare('DELETE FROM room_memories WHERE rooms_id_fk=?').run(id);
        db.prepare('DELETE FROM room_books WHERE rooms_id_fk=?').run(id);
        db.prepare('DELETE FROM rooms WHERE rooms_id_pk=?').run(id);
        send(res, 200, { ok: true });
    },
    'GET /api/room': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('id') || 1);
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        const msgs = db.prepare(MSG_SQL + ' WHERE m.rooms_id_fk=? ORDER BY m.messages_id_pk').all(roomId);
        const members = db.prepare(`SELECT rm.*, c.name card_name, c.avatar card_avatar, u.handle, pc.name persona_name, pc.avatar persona_avatar, pc.cards_id_pk persona_id,
            CASE WHEN IFNULL(c.is_persona,0)=1 THEN 'human' ELSE 'ai' END kind,
            CASE WHEN IFNULL(c.is_persona,0)=1 THEN c.owner_users_id_fk END users_id_fk,
            (c.owner_users_id_fk=?) AS mine
            FROM room_members rm
            LEFT JOIN cards c ON c.cards_id_pk=rm.cards_id_fk LEFT JOIN users u ON u.users_id_pk=c.owner_users_id_fk
            LEFT JOIN cards pc ON pc.owner_users_id_fk=u.users_id_pk AND pc.is_persona=1 WHERE rm.rooms_id_fk=?`).all(u.users_id_pk, roomId);
        const lastMem = db.prepare("SELECT m.content text FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart' ORDER BY m.memories_id_pk DESC LIMIT 1").get(roomId);
        send(res, 200, { messages: msgs, members, lastMem });
    },
    'POST /api/room/trigger': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
        db.prepare('UPDATE rooms SET ai_trigger=? WHERE rooms_id_pk=?').run(b.mode || 'manual', b.room || 1);
        send(res, 200, { ok: true });
    },
    'GET /api/roombg': (req, res) => {
        const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
        const r = db.prepare('SELECT bg FROM rooms WHERE rooms_id_pk=?').get(id);
        const file = r?.bg && path.join(BG_DIR, r.bg);
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'no background' });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(file).pipe(res);
    },
    'POST /api/room/background': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
        if (!b.png_b64) return send(res, 400, { error: 'png_b64 required' });
        const file = `${b.room || 1}.png`;
        fs.writeFileSync(path.join(BG_DIR, file), Buffer.from(b.png_b64, 'base64'));
        db.prepare('UPDATE rooms SET bg=? WHERE rooms_id_pk=?').run(file, b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/room/background/remove': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
        const r = db.prepare('SELECT bg FROM rooms WHERE rooms_id_pk=?').get(b.room || 1);
        if (r?.bg && fs.existsSync(path.join(BG_DIR, r.bg))) fs.unlinkSync(path.join(BG_DIR, r.bg));
        db.prepare("UPDATE rooms SET bg='' WHERE rooms_id_pk=?").run(b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/room/settings': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
        db.prepare('UPDATE rooms SET max_context=COALESCE(?,max_context) WHERE rooms_id_pk=?')
            .run(b.maxContext === undefined ? null : b.maxContext, b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/room/memsettings': async (req, res, u) => {
        // Per-chat memory *settings* are gone — rooms follow a memory profile.
        // The only per-room aspect left is which profile the room follows.
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
        if (b.memProfile !== undefined) {
            const pid = Number(b.memProfile) || 0;
            // Rooms may only follow profiles owned by the room owner.
            if (pid && !db.prepare('SELECT 1 FROM mem_profiles WHERE mem_profiles_id_pk=? AND users_id_fk=?').get(pid, u.users_id_pk))
                return send(res, 403, { error: 'room can only follow your own profiles' });
            db.prepare('UPDATE rooms SET mem_profiles_id_fk=? WHERE rooms_id_pk=?').run(pid, rid);
        }
        send(res, 200, { ok: true });
    },
    'POST /api/members/talkativeness': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        // Room owner sets anyone's; a member sets their own characters.
        const ownCard = b.cardId && db.prepare('SELECT 1 FROM cards WHERE cards_id_pk=? AND owner_users_id_fk=?').get(b.cardId, u.users_id_pk);
        if (!roomOwnerOnly(rid, u) && !ownCard) return send(res, 403, { error: 'room owner only' });
        db.prepare(`UPDATE room_members SET talkativeness=? WHERE cards_id_fk=? AND rooms_id_fk=?`)
            .run(Math.max(0, Math.min(100, Number(b.value) || 0)), b.cardId, rid);
        send(res, 200, { ok: true });
    },
};
