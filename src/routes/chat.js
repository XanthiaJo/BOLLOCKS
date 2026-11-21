// Live chat routes: SSE stream, say, generate, delete, genstats.
import { db, MSG_SQL } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { roomMember, roomOwnerOnly } from '../lib/access.js';
import { streams, push } from '../lib/sse.js';
import { rollDice, formatRoll } from '../lib/dice.js';
import { generateReply, genStats, maybeSummarize } from '../generate.js';

// Rooms with a reply chain currently generating — a say arriving mid-chain
// doesn't start a second one; it's already in history, so the running
// chain's next pick sees it like any other context.
const genBusy = new Set();

export default {
    'GET /api/genstats': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room') || 1);
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        send(res, 200, { stats: genStats[roomId] || null });
    },
    'GET /api/promptlog': async (req, res, u) => {
        const q = new URL(req.url, 'http://x').searchParams;
        const roomId = Number(q.get('room') || 1);
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        const limit = Math.min(Math.max(Number(q.get('n') || 25), 1), 100);
        const rows = db.prepare('SELECT * FROM prompt_logs WHERE rooms_id_fk=? ORDER BY prompt_logs_id_pk DESC LIMIT ?').all(roomId, limit);
        send(res, 200, { logs: rows.map(r => ({ ...r, request: JSON.parse(r.request) })) });
    },
    'GET /api/stream': (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room') || 1);
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.flushHeaders(); // writeHead alone buffers until the first write — flush so EventSource connects now
        if (!streams.has(roomId)) streams.set(roomId, new Set());
        streams.get(roomId).add(res);
        // Heartbeat — a comment line EventSource ignores. Without it a dead
        // socket looks alive to the browser forever after a restart, and
        // pushes silently stop arriving until the page is refreshed.
        const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { clearInterval(hb); } }, 20000);
        req.on('close', () => { clearInterval(hb); streams.get(roomId)?.delete(res); });
    },
    'POST /api/say': async (req, res, u) => {
        const b = await readBody(req);
        const roomId = b.room || 1;
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        const cardId = b.cardId ?? db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk)?.cards_id_pk ?? null;
        // Slash commands: resolved server-side and posted as system messages
        // (cards_id_fk NULL) — impartial, deterministic, and readable by
        // memory extraction as authoritative outcomes. The command line
        // itself is never stored.
        const cmd = String(b.text ?? '').match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
        let msg;
        if (cmd) {
            const who = (cardId && db.prepare('SELECT name FROM cards WHERE cards_id_pk=?').get(cardId)?.name) || u.handle;
            let text;
            if (cmd[1] === 'roll') {
                const vs = cmd[2]?.match(/^(.*?)\s+(?:vs|dc)\s+(\d+)\s*$/i);
                const r = rollDice(vs ? vs[1] : cmd[2]);
                if (!r) return send(res, 400, { error: 'usage: /roll NdS±K [vs TARGET]' });
                text = formatRoll(who, r, vs ? Number(vs[2]) : null);
            } else if (cmd[1] === 'ruling') {
                if (!roomOwnerOnly(roomId, u)) return send(res, 403, { error: 'only the room owner can issue rulings' });
                if (!cmd[2]?.trim()) return send(res, 400, { error: 'usage: /ruling <decision>' });
                text = `Ruling: ${cmd[2].trim()}`;
            } else return send(res, 400, { error: `unknown command /${cmd[1]}` });
            const r = db.prepare('INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,NULL,?)').run(roomId, text);
            msg = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r.lastInsertRowid);
            b.text = msg.text; // named-trigger matching should see the result
        } else {
            const r = db.prepare(`INSERT INTO messages (rooms_id_fk,cards_id_fk,text)
                VALUES (?,?,?)`).run(roomId, cardId, b.text);
            msg = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r.lastInsertRowid);
        }
        push(roomId, { type: 'message', message: msg });
        send(res, 200, msg);
        // AI trigger policy for this room. Picks reply one at a time in a
        // rolled (shuffled) order: each reply is inserted before the next AI
        // prompts, so later speakers see it in history and the group reads
        // as a conversation, not parallel monologues. Extraction waits for
        // the chain to finish so it sees all the replies.
        const roomRow = db.prepare('SELECT ai_trigger FROM rooms WHERE rooms_id_pk=?').get(msg.rooms_id_fk);
        if (roomRow?.ai_trigger && roomRow.ai_trigger !== 'manual' && !genBusy.has(msg.rooms_id_fk)) {
            const ais = db.prepare(`SELECT c.*, c.cards_id_pk AS id, rm.talkativeness FROM room_members rm JOIN cards c ON c.cards_id_pk=rm.cards_id_fk
                WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 ORDER BY rm.cards_id_fk`).all(msg.rooms_id_fk);
            // Talkativeness: per-member 0–100% chance to reply (named always fires).
            const roll = c => Math.random() * 100 < (c.talkativeness ?? 50);
            let picks = [];
            if (roomRow.ai_trigger === 'all') picks = ais.filter(roll);
            else if (roomRow.ai_trigger === 'named')
                picks = ais.filter(c => new RegExp('\\b' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(b.text || ''));
            else if (roomRow.ai_trigger === 'roundrobin') picks = ais.length ? [ais[Math.floor(Math.random() * ais.length)]] : [];
            for (let i = picks.length - 1; i > 0; i--) { // roll for who speaks first
                const j = Math.floor(Math.random() * (i + 1));
                [picks[i], picks[j]] = [picks[j], picks[i]];
            }
            genBusy.add(msg.rooms_id_fk);
            (async () => {
                try {
                    for (const card of picks) {
                        push(msg.rooms_id_fk, { type: 'typing', name: card.name, ai: 1 });
                        try {
                            const text = await generateReply(msg.rooms_id_fk, card);
                            if (!text?.trim()) continue;
                            const r2 = db.prepare(`INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,?,?)`)
                                .run(msg.rooms_id_fk, card.id, text);
                            const m2 = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r2.lastInsertRowid);
                            push(msg.rooms_id_fk, { type: 'message', message: m2 });
                        } catch (e) { console.error('[gen]', e.message); }
                        finally { push(msg.rooms_id_fk, { type: 'typing', name: card.name, off: 1 }); }
                    }
                } finally {
                    genBusy.delete(msg.rooms_id_fk);
                    maybeSummarize(msg.rooms_id_fk).catch(e => console.error('[mem]', e.message));
                }
            })();
        } else {
            maybeSummarize(msg.rooms_id_fk).catch(e => console.error('[mem]', e.message));
        }
    },
    'POST /api/typing': async (req, res, u) => {
        // Typing presence ping — clients throttle their sends; the event is
        // fanned out with the sender's user id so each client can hide its own.
        const b = await readBody(req);
        const roomId = b.room || 1;
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        const name = (b.cardId && db.prepare('SELECT name FROM cards WHERE cards_id_pk=?').get(b.cardId)?.name)
            || db.prepare('SELECT name FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk)?.name
            || u.handle;
        push(roomId, { type: 'typing', name, human: 1, user: u.users_id_pk });
        send(res, 200, { ok: true });
    },
    'POST /api/messages/delete': async (req, res, u) => {
        const b = await readBody(req);
        const m = db.prepare('SELECT rooms_id_fk FROM messages WHERE messages_id_pk=?').get(b.id || b.world_books_id_pk);
        if (!m) return send(res, 404, { error: 'no message' });
        if (!roomMember(m.rooms_id_fk, u)) return send(res, 403, { error: 'not a room member' });
        const id = b.id || b.world_books_id_pk;
        db.prepare('UPDATE messages SET supersedes_messages_id_fk=NULL WHERE supersedes_messages_id_fk=?').run(id);
        db.prepare('DELETE FROM messages WHERE messages_id_pk=?').run(id);
        push(m.rooms_id_fk, { type: 'delete', id });
        send(res, 200, { ok: true });
    },
    'POST /api/generate': async (req, res, u) => {
        const b = await readBody(req);
        const roomId = b.room || 1;
        if (!roomMember(roomId, u)) return send(res, 403, { error: 'not a room member' });
        const npc = db.prepare(`SELECT c.*, c.cards_id_pk AS id FROM room_members rm JOIN cards c ON c.cards_id_pk=rm.cards_id_fk
            WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 ${b.card ? 'AND c.cards_id_pk=?' : ''} ORDER BY rm.cards_id_fk`).all(roomId, ...(b.card ? [b.card] : []))[0];
        if (!npc) return send(res, 404, { error: 'no AI member' });
        push(roomId, { type: 'typing', name: npc.name, ai: 1 });
        try {
            const text = await generateReply(roomId, npc);
            const r = db.prepare(`INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,?,?)`)
                .run(roomId, npc.id, text);
            const msg = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r.lastInsertRowid);
            push(roomId, { type: 'message', message: msg });
            send(res, 200, msg);
            maybeSummarize(roomId).catch(e => console.error('[mem]', e.message));
        } catch (err) {
            send(res, 500, { error: String(err?.message || err) });
        } finally {
            push(roomId, { type: 'typing', name: npc.name, off: 1 });
        }
    },
};
