import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seed, login, userForToken, createUser, migrateProfiles, migrateSchema, MSG_SQL } from './db.js';
import { generateReply, genStats, maybeSummarize } from './generate.js';
import { extractCardJson, normalizeCard } from './pngcard.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8100);
migrateSchema();
migrateProfiles();
if (process.env.BOLLOCKS_SEED !== '0') seed();

// ---- SSE fan-out per room ----
const streams = new Map(); // rooms_id_fk -> Set<res>
const push = (roomId, evt) => {
    for (const res of streams.get(Number(roomId)) || [])
        try { res.write(`data:${JSON.stringify(evt)}\n\n`); } catch { }
};

// ---- HTTP helpers ----
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
const CARDS_DIR = path.join(process.cwd(), 'data', 'cards');
fs.mkdirSync(CARDS_DIR, { recursive: true });
const BG_DIR = path.join(process.cwd(), 'data', 'bg');
fs.mkdirSync(BG_DIR, { recursive: true });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// Local testing mode: no token → ?as=<handle> impersonation, else first user.
const auth = req =>
    userForToken(req.headers.authorization?.replace(/^Bearer /, '') || new URL(req.url, 'http://x').searchParams.get('token'));

const router = {
    'POST /api/login': async (req, res) => {
        const b = await readBody(req);
        const s = login(b.handle, b.password);
        if (!s) return send(res, 401, { error: 'bad credentials' });
        send(res, 200, { token: s.token, handle: s.user.handle });
    },
    'POST /api/register': async (req, res) => {
        const b = await readBody(req);
        if (!b.handle || !b.password) return send(res, 400, { error: 'handle+password required' });
        try { send(res, 200, { id: createUser(b.handle, b.password) }); }
        catch { send(res, 409, { error: 'handle taken' }); }
    },
    'GET /api/lastmem': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room')) || 1;
        send(res, 200, db.prepare("SELECT m.content text FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart' ORDER BY m.memories_id_pk DESC LIMIT 1").get(roomId) || null);
    },
    'GET /api/me': async (req, res, u) => {
        const persona = db.prepare('SELECT cards_id_pk AS id,name FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk);
        send(res, 200, { handle: u.handle, persona: persona || null });
    },
    'POST /api/persona': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE cards SET is_persona=0 WHERE owner_users_id_fk=?').run(u.users_id_pk);
        if (b.cardId) db.prepare('UPDATE cards SET is_persona=1 WHERE cards_id_pk=? AND owner_users_id_fk=?').run(b.cardId, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'GET /api/memories': async (req, res, u) => {
        const q = new URL(req.url, 'http://x').searchParams;
        const card = Number(q.get('card') ?? -1);
        const room = Number(q.get('room') || 0);
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
        const id = db.prepare('INSERT INTO memories (content,type,origin,triggers) VALUES (?,?,?,?)')
            .run(b.content || '', b.type || 'fact', 'user', b.triggers || '').lastInsertRowid;
        db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(b.room || 1, id);
        if (b.cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, b.cardId);
        send(res, 200, { id });
    },
    'POST /api/memories/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
    db.prepare('DELETE FROM room_memories WHERE memories_id_fk=?').run(id);
    db.prepare('DELETE FROM memory_cards WHERE memories_id_fk=?').run(id);
    db.prepare('DELETE FROM memories WHERE memories_id_pk=?').run(id);
        send(res, 200, { ok: true });
    },
    'GET /api/genstats': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room') || 1);
        send(res, 200, { stats: genStats[roomId] || null });
    },
    'GET /api/world/books': async (req, res, u) => {
        const books = db.prepare(`SELECT b.*, b.world_books_id_pk AS id, u.handle owner,
            (SELECT COUNT(*) FROM book_entries WHERE world_books_id_fk=b.world_books_id_pk) cnt
            FROM world_books b LEFT JOIN users u ON u.users_id_pk=b.owner_users_id_fk ORDER BY b.world_books_id_pk`).all();
        const rooms = db.prepare(`SELECT r.rooms_id_pk AS id,r.name,rb.world_books_id_fk world_books_id_fk FROM rooms r
            LEFT JOIN room_books rb ON rb.rooms_id_fk=r.rooms_id_pk`).all();
        send(res, 200, { books, rooms });
    },
    'POST /api/world/books': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare('INSERT INTO world_books (owner_users_id_fk,name) VALUES (?,?)').run(u.users_id_pk, b.name).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/world/books/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM world_entries WHERE world_entries_id_pk IN (SELECT world_entries_id_fk FROM book_entries WHERE world_books_id_fk=?)').run(b.world_books_id_pk);
        db.prepare('DELETE FROM book_entries WHERE world_books_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM world_books WHERE world_books_id_pk=? AND owner_users_id_fk=?').run(b.world_books_id_pk, u.users_id_pk);
        db.prepare('DELETE FROM room_books WHERE world_books_id_fk=?').run(b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/world/link': async (req, res, u) => {
        const b = await readBody(req);
        if (b.book) db.prepare('INSERT OR IGNORE INTO room_books (rooms_id_fk,world_books_id_fk) VALUES (?,?)').run(b.room || 1, b.book);
        else db.prepare('DELETE FROM room_books WHERE rooms_id_fk=?').run(b.room || 1);
        send(res, 200, { ok: true });
    },
    // ST lorebook JSON import: {entries: {0: {key, keysecondary, comment, content, constant, order, disable}}}
    'POST /api/world/import': async (req, res, u) => {
        const b = await readBody(req);
        const raw = typeof b.book === 'string' ? JSON.parse(b.book) : b.book;
        const list = Object.values(raw?.entries || {});
        if (!list.length) return send(res, 400, { error: 'no entries found' });
        const bid = db.prepare('INSERT INTO world_books (owner_users_id_fk,name) VALUES (?,?)')
            .run(u.users_id_pk, b.name || raw.name || 'Imported book').lastInsertRowid;
        const ins = db.prepare(`INSERT INTO world_entries (comment,content,constant,enabled,ord)
            VALUES (?,?,?,?,?)`);
        const link = db.prepare('INSERT INTO book_entries (world_books_id_fk,world_entries_id_fk) VALUES (?,?)');
        const ik = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
        for (const e of list) {
            const eid = ins.run(e.comment || '', e.content || '', e.constant ? 1 : 0, e.disable ? 0 : 1, e.order || 0).lastInsertRowid;
            for (const w of (e.key || [])) ik.run(eid, w, 'primary');
            for (const w of (e.keysecondary || [])) ik.run(eid, w, 'secondary');
            link.run(bid, eid);
        }
        send(res, 200, { id: bid, count: list.length });
    },
    'GET /api/world': async (req, res, u) => {
        const bookId = Number(new URL(req.url, 'http://x').searchParams.get('book') || 0);
        const entries = db.prepare('SELECT e.*, e.world_entries_id_pk AS id FROM world_entries e JOIN book_entries be ON be.world_entries_id_fk=e.world_entries_id_pk WHERE be.world_books_id_fk=? ORDER BY e.ord, e.world_entries_id_pk').all(bookId);
        const ks = db.prepare('SELECT word,kind FROM world_entry_keys WHERE world_entries_id_fk=?');
        for (const e of entries) {
            const rows = ks.all(e.id);
            e.keys = JSON.stringify(rows.filter(r=>r.kind==='primary').map(r=>r.word));
            e.keysecondary = JSON.stringify(rows.filter(r=>r.kind==='secondary').map(r=>r.word));
        }
        send(res, 200, { entries });
    },
    'POST /api/world': async (req, res, u) => {
        const b = await readBody(req);
        const keys = typeof b.keys === 'string'
            ? b.keys.split(',').map(k => k.trim()).filter(Boolean) : (b.keys || []);
        const secondary = typeof b.keysecondary === 'string'
            ? b.keysecondary.split(',').map(k => k.trim()).filter(Boolean) : (b.keysecondary || []);
        const id = db.prepare('INSERT INTO world_entries (comment,content,constant,enabled,ord) VALUES (?,?,?,?,?)')
            .run(b.comment || '', b.content || '', b.constant ? 1 : 0, b.enabled === false ? 0 : 1, b.ord || 0).lastInsertRowid;
        const ik2 = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
        for (const w of keys) ik2.run(id, w, 'primary');
        for (const w of secondary) ik2.run(id, w, 'secondary');
        if (b.book) db.prepare('INSERT OR IGNORE INTO book_entries (world_books_id_fk,world_entries_id_fk) VALUES (?,?)').run(b.book, id);
        send(res, 200, { id });
    },
    'POST /api/world/update': async (req, res, u) => {
        const b = await readBody(req);
        const keys = typeof b.keys === 'string'
            ? b.keys.split(',').map(k => k.trim()).filter(Boolean) : b.keys;
        const secondary = typeof b.keysecondary === 'string'
            ? b.keysecondary.split(',').map(k => k.trim()).filter(Boolean) : b.keysecondary;
        if (keys || secondary) {
            db.prepare('DELETE FROM world_entry_keys WHERE world_entries_id_fk=?').run(b.world_books_id_pk);
            const ik = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
            for (const w of (keys || [])) ik.run(b.world_books_id_pk, w, 'primary');
            for (const w of (secondary || [])) ik.run(b.world_books_id_pk, w, 'secondary');
        }
        db.prepare(`UPDATE world_entries SET
            comment=COALESCE(?,comment), content=COALESCE(?,content),
            constant=COALESCE(?,constant), enabled=COALESCE(?,enabled), ord=COALESCE(?,ord) WHERE world_entries_id_pk=?`)
            .run(b.comment, b.content,
                b.constant === undefined ? null : (b.constant ? 1 : 0),
                b.enabled === undefined ? null : (b.enabled ? 1 : 0), b.ord, b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/world/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM book_entries WHERE world_entries_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM world_entries WHERE world_entries_id_pk=?').run(b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'GET /api/users': async (req, res, u) =>
        send(res, 200, { users: db.prepare('SELECT users_id_pk AS id,handle FROM users ORDER BY users_id_pk').all() }),
    'POST /api/cards/avatar': async (req, res, u) => {
        const b = await readBody(req);
        const card = db.prepare('SELECT owner_users_id_fk FROM cards WHERE cards_id_pk=?').get(b.world_books_id_pk);
        if (!card || card.owner_users_id_fk !== u.users_id_pk) return send(res, 403, { error: 'not your card' });
        const file = `cards/${b.world_books_id_pk}.png`;
        fs.writeFileSync(path.join(CARDS_DIR, `${b.world_books_id_pk}.png`), Buffer.from(b.png_b64, 'base64'));
        db.prepare('UPDATE cards SET avatar=? WHERE cards_id_pk=?').run(file, b.world_books_id_pk);
        send(res, 200, { ok: true, avatar: file });
    },
    'GET /api/cards': async (req, res, u) => {
        // Own cards + cards in rooms shared with the caller — a non-owner
        // shouldn't even know other characters exist.
        const cards = db.prepare(`SELECT c.*, c.cards_id_pk AS id, u.handle owner FROM cards c
            LEFT JOIN users u ON u.users_id_pk=c.owner_users_id_fk
            WHERE c.owner_users_id_fk = ? OR c.cards_id_pk IN (
                SELECT m2.cards_id_fk FROM members m2
                JOIN room_members r2 ON r2.members_id_fk=m2.members_id_pk
                JOIN room_members re ON re.rooms_id_fk = r2.rooms_id_fk
                JOIN members me ON me.members_id_pk=re.members_id_fk JOIN cards cc ON cc.cards_id_pk=me.cards_id_fk AND cc.owner_users_id_fk = ?
                WHERE m2.cards_id_fk IS NOT NULL
            ) OR (c.is_persona=1 AND c.owner_users_id_fk IN (
                SELECT c3.owner_users_id_fk FROM members m3 JOIN cards c3 ON c3.cards_id_pk=m3.cards_id_fk
                JOIN room_members r3 ON r3.members_id_fk=m3.members_id_pk
                JOIN room_members re2 ON re2.rooms_id_fk = r3.rooms_id_fk
                JOIN members me2 ON me2.members_id_pk=re2.members_id_fk
                JOIN cards cc2 ON cc2.cards_id_pk=me2.cards_id_fk AND cc2.owner_users_id_fk = ?
                WHERE c3.owner_users_id_fk IS NOT NULL
            )) ORDER BY c.name`).all(u.users_id_pk, u.users_id_pk, u.users_id_pk);
        send(res, 200, { cards });
    },
    'POST /api/cards': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare(`INSERT INTO cards (owner_users_id_fk,name,description,personality,scenario,first_message,
            mes_example,system_prompt,post_history_instructions,tags,creator,api_profiles_id_fk) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, b.name, b.description || '', b.personality || '', b.scenario || '', b.first_message || '',
                b.mes_example || '', b.system_prompt || '', b.post_history_instructions || '',
                JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : (b.tags || [])),
                b.creator || '', b.profileId || null).lastInsertRowid;
        send(res, 200, { id });
    },
    // Import a SillyTavern card: {png_b64} for PNG cards, {card} for JSON.
    'POST /api/cards/import': async (req, res, u) => {
        const b = await readBody(req);
        let raw = null;
        let avatarPath = '';
        if (b.png_b64) {
            const png = Buffer.from(b.png_b64, 'base64');
            raw = extractCardJson(png);
            if (!raw) return send(res, 400, { error: 'no character data in PNG' });
            const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cards');
            fs.mkdirSync(dir, { recursive: true });
            avatarPath = `cards/import-${Date.now()}.png`;
            fs.writeFileSync(path.join(dir, path.basename(avatarPath)), png);
        } else if (b.card) {
            raw = typeof b.card === 'string' ? JSON.parse(b.card) : b.card;
        }
        if (!raw) return send(res, 400, { error: 'no card data supplied' });
        const c = normalizeCard(raw);
        const id = db.prepare(`INSERT INTO cards (owner_users_id_fk,name,description,personality,scenario,first_message,mes_example,
            system_prompt,post_history_instructions,alternate_greetings,tags,creator,creatorcomment,character_version,avatar,card_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, c.name, c.description, c.personality, c.scenario, c.first_mes, c.mes_example,
                c.system_prompt, c.post_history_instructions, JSON.stringify(c.alternate_greetings),
                JSON.stringify(c.tags), c.creator, c.creatorcomment, c.character_version, avatarPath,
                JSON.stringify(raw)).lastInsertRowid;
        send(res, 200, { id, name: c.name });
    },
    // Card avatar image.
    'GET /api/avatar': (req, res) => {
        const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
        const c = db.prepare('SELECT avatar,name FROM cards WHERE cards_id_pk=?').get(id);
        const file = c?.avatar && path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', c.avatar);
        if (!c || !c.avatar || !fs.existsSync(file)) {
            const ch = (c?.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
            const hue = [...(c?.name || '')].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="hsl(${hue},40%,30%)"/><text x="36" y="47" font-family="system-ui" font-size="34" fill="#ddd" text-anchor="middle">${ch}</text></svg>`);
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(file).pipe(res);
    },
    'POST /api/cards/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE cards SET name=COALESCE(?,name), description=COALESCE(?,description),
            personality=COALESCE(?,personality), scenario=COALESCE(?,scenario),
            first_message=COALESCE(?,first_message), mes_example=COALESCE(?,mes_example),
            system_prompt=COALESCE(?,system_prompt), post_history_instructions=COALESCE(?,post_history_instructions),
            tags=COALESCE(?,tags), creator=COALESCE(?,creator), api_profiles_id_fk=? WHERE cards_id_pk=? AND owner_users_id_fk=?`)
            .run(b.name, b.description, b.personality, b.scenario, b.first_message, b.mes_example,
                b.system_prompt, b.post_history_instructions,
                b.tags !== undefined ? JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : b.tags) : null,
                b.creator, b.profileId ?? null, b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/cards/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM cards WHERE cards_id_pk=? AND owner_users_id_fk=?').run(b.world_books_id_pk, u.users_id_pk);
        db.prepare('DELETE FROM room_members WHERE members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk=?)').run(b.world_books_id_pk);
            db.prepare('DELETE FROM members WHERE cards_id_fk=?').run(b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/members': async (req, res, u) => {
        const b = await readBody(req);
        if (b.userId) {
            const pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(b.userId)?.cards_id_pk;
            if (!pc) return send(res, 400, { error: 'user has no persona card' });
            let mid = db.prepare('SELECT members_id_pk FROM members WHERE cards_id_fk=?').get(pc)?.members_id_pk;
            if (!mid) mid = db.prepare('INSERT INTO members (cards_id_fk) VALUES (?)').run(pc).lastInsertRowid;
            db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)').run(b.room || 1, mid);
            return send(res, 200, { ok: true });
        }
        const card = db.prepare('SELECT owner_users_id_fk FROM cards WHERE cards_id_pk=?').get(b.cardId);
        if (!card) return send(res, 404, { error: 'card not found' });
        if (card.owner_users_id_fk !== u.users_id_pk) return send(res, 403, { error: 'not your character' });
        let mid2 = db.prepare('SELECT members_id_pk FROM members WHERE cards_id_fk=?').get(b.cardId)?.members_id_pk;
        if (!mid2) mid2 = db.prepare('INSERT INTO members (cards_id_fk) VALUES (?)').run(b.cardId).lastInsertRowid;
        db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)').run(b.room || 1, mid2);
        send(res, 200, { ok: true });
    },
    'POST /api/members/remove': async (req, res, u) => {
        const b = await readBody(req);
        if (b.cardId) db.prepare('DELETE FROM room_members WHERE rooms_id_fk=? AND members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk=?)').run(b.room || 1, b.cardId);
        else if (b.userId) {
            const pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(b.userId)?.cards_id_pk;
            if (pc) db.prepare('DELETE FROM room_members WHERE rooms_id_fk=? AND members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk=?)').run(b.room || 1, pc);
        }
        send(res, 200, { ok: true });
    },
    'POST /api/users/delete': async (req, res, u) => {
        const b = await readBody(req);
        const target = b.handle
            ? db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=? COLLATE NOCASE').get(b.handle)?.id
            : b.world_books_id_pk;
        if (!target || target === u.users_id_pk) return send(res, 400, { error: 'no such user' });
        db.prepare('DELETE FROM sessions WHERE users_id_fk=?').run(target);
        db.prepare('DELETE FROM room_members WHERE members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk IN (SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=?))').run(target);
            db.prepare('DELETE FROM members WHERE cards_id_fk IN (SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=?)').run(target);
        db.prepare('DELETE FROM users WHERE users_id_pk=?').run(target);
        send(res, 200, { ok: true });
    },
    'GET /api/rooms': async (req, res, u) => {
        const rooms = db.prepare(`SELECT DISTINCT r.rooms_id_pk AS id, r.name, r.ai_trigger, r.auto_mem, r.mem_every, r.mem_budget, r.mem_max, r.max_context,
            r.mem_max_fact, r.mem_max_event, r.mem_max_relationship, r.mem_max_preference, r.mem_extraction_prompt, r.mem_context_threshold, r.mem_response_length,
            r.mem_gen_budget, r.mem_unlimited, r.mem_unified, r.mem_triggers, r.mem_autotune, r.mem_refresh, r.mem_activity, r.mem_extraction_profile_id,
            r.mem_profiles_id_fk,
            (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.rooms_id_fk=r.rooms_id_pk) AS members, r.bg FROM rooms r
            JOIN room_members rm ON rm.rooms_id_fk=r.rooms_id_pk JOIN members m ON m.members_id_pk=rm.members_id_fk JOIN cards c ON c.cards_id_pk=m.cards_id_fk WHERE c.owner_users_id_fk=? ORDER BY r.rooms_id_pk`).all(u.users_id_pk);
        send(res, 200, { rooms });
    },
    'POST /api/rooms': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare('INSERT INTO rooms (name) VALUES (?)').run(b.name).lastInsertRowid;
        const pc0 = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk)?.cards_id_pk;
        if (pc0) {
            const mid3 = db.prepare('SELECT members_id_pk FROM members WHERE cards_id_fk=?').get(pc0)?.members_id_pk
                ?? db.prepare('INSERT INTO members (cards_id_fk) VALUES (?)').run(pc0).lastInsertRowid;
            db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)').run(id, mid3);
        }
        send(res, 200, { id, name: b.name });
    },
    'POST /api/rooms/update': async (req, res, u) => {
        const b = await readBody(req);
        if (b.name) db.prepare('UPDATE rooms SET name=? WHERE rooms_id_pk=?').run(b.name, b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/rooms/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM messages WHERE rooms_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM room_members WHERE rooms_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM memories WHERE rooms_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM room_books WHERE rooms_id_fk=?').run(b.world_books_id_pk);
        db.prepare('DELETE FROM rooms WHERE rooms_id_pk=?').run(b.world_books_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/models': async (req, res, u) => {
        const b = await readBody(req);
        let apiUrl = b.apiUrl || '', key = b.key || '', headers = b.headers;
        if (b.profileId) {
            const p = db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=? AND users_id_fk=?').get(b.profileId, u.users_id_pk);
            if (p) { apiUrl = apiUrl || p.api_url; key = key || p.key; headers = headers === undefined ? p.headers : headers; }
        }
        if (!apiUrl) return send(res, 400, { error: 'api url required' });
        try {
            const r = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
                headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
                    ...(() => { try { return JSON.parse(headers || '{}'); } catch { return {}; } })() },
            });
            const d = await r.json();
            send(res, 200, { models: (d.data || []).map(m => m.id).sort() });
        } catch (e) { send(res, 502, { error: String(e.message || e) }); }
    },
    'GET /api/profiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT api_profiles_id_pk AS id,name,api_url,model,active,strip_prefix,headers,context_size,max_response,(key!=\'\') has_key FROM api_profiles WHERE users_id_fk=? ORDER BY api_profiles_id_pk').all(u.users_id_pk);
        send(res, 200, { profiles });
    },
    'POST /api/profiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const first = !db.prepare('SELECT 1 FROM api_profiles WHERE users_id_fk=?').get(u.users_id_pk);
        const id = db.prepare('INSERT INTO api_profiles (users_id_fk,name,api_url,model,key,active,strip_prefix) VALUES (?,?,?,?,?,?,?)')
            .run(u.users_id_pk, b.name, b.apiUrl || '', b.model || '', b.key || '', first ? 1 : 0, b.stripPrefix === false ? 0 : 1).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/profiles/update': async (req, res, u) => {
        const b = await readBody(req);
        const sets = ['name=?', 'api_url=?', 'model=?'];
        const args = [b.name, b.apiUrl, b.model];
        if (b.headers !== undefined) { sets.push('headers=?'); args.push(b.headers || '{}'); }
        if (b.contextSize !== undefined) { sets.push('context_size=?'); args.push(Number(b.contextSize) || 0); }
        if (b.maxResponse !== undefined) { sets.push('max_response=?'); args.push(Number(b.maxResponse) || 2048); }
        if (b.stripPrefix !== undefined) { sets.push('strip_prefix=?'); args.push(b.stripPrefix ? 1 : 0); }
        if (b.key) { sets.push('key=?'); args.push(b.key); }
        args.push(b.world_books_id_pk, u.users_id_pk);
        db.prepare(`UPDATE api_profiles SET ${sets.join(',')} WHERE api_profiles_id_pk=? AND users_id_fk=?`).run(...args);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/activate': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE api_profiles SET active=0 WHERE users_id_fk=?').run(u.users_id_pk);
        db.prepare('UPDATE api_profiles SET active=1 WHERE api_profiles_id_pk=? AND users_id_fk=?').run(b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM api_profiles WHERE api_profiles_id_pk=? AND users_id_fk=?').run(b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    // Smart-memory profiles: named presets of the mem_* room settings.
    'GET /api/memprofiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT * FROM mem_profiles WHERE users_id_fk=? ORDER BY mem_profiles_id_pk').all(u.users_id_pk);
        send(res, 200, { profiles });
    },
    'POST /api/memprofiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const vals = [b.auto ? 1 : 0, b.every ?? 10, b.budget ?? 800, b.max ?? 50,
            b.maxFact ?? 50, b.maxEvent ?? 50, b.maxRel ?? 50, b.maxPref ?? 50,
            b.extractionPrompt || '', b.contextThreshold ?? 80, b.responseLength ?? 2000,
            b.genBudget ?? 2000, b.unlimited ? 1 : 0, (b.unified ?? 1) ? 1 : 0, b.triggers ? 1 : 0,
            b.autotune ? 1 : 0, b.refresh ?? 1, b.activity ? 1 : 0, b.profileId ?? 0];
        const id = db.prepare(`INSERT INTO mem_profiles (users_id_fk,name,auto_mem,mem_every,mem_budget,mem_max,
            mem_max_fact,mem_max_event,mem_max_relationship,mem_max_preference,mem_extraction_prompt,
            mem_context_threshold,mem_response_length,mem_gen_budget,mem_unlimited,mem_unified,mem_triggers,
            mem_autotune,mem_refresh,mem_activity,mem_extraction_profile_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, b.name, ...vals).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/memprofiles/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE mem_profiles SET auto_mem=?, mem_every=?, mem_budget=?, mem_max=?,
            mem_max_fact=?, mem_max_event=?, mem_max_relationship=?, mem_max_preference=?,
            mem_extraction_prompt=?, mem_context_threshold=?, mem_response_length=?,
            mem_gen_budget=?, mem_unlimited=?, mem_unified=?, mem_triggers=?,
            mem_autotune=?, mem_refresh=?, mem_activity=?, mem_extraction_profile_id=?
            WHERE mem_profiles_id_pk=? AND users_id_fk=?`)
            .run(b.auto ? 1 : 0, b.every ?? 10, b.budget ?? 800, b.max ?? 50,
                b.maxFact ?? 50, b.maxEvent ?? 50, b.maxRel ?? 50, b.maxPref ?? 50,
                b.extractionPrompt || '', b.contextThreshold ?? 80, b.responseLength ?? 2000,
                b.genBudget ?? 2000, b.unlimited ? 1 : 0, (b.unified ?? 1) ? 1 : 0, b.triggers ? 1 : 0,
                b.autotune ? 1 : 0, b.refresh ?? 1, b.activity ? 1 : 0, b.profileId ?? 0,
                b.id, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/memprofiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM mem_profiles WHERE mem_profiles_id_pk=? AND users_id_fk=?').run(b.id, u.users_id_pk);
        // Rooms following the deleted profile fall back to per-chat settings.
        db.prepare('UPDATE rooms SET mem_profiles_id_fk=0 WHERE mem_profiles_id_fk=?').run(b.id);
        send(res, 200, { ok: true });
    },
    'GET /api/room': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('id') || 1);
        const msgs = db.prepare(MSG_SQL + ' WHERE m.rooms_id_fk=? ORDER BY m.messages_id_pk').all(roomId);
        const members = db.prepare(`SELECT m.*, c.name card_name, c.avatar card_avatar, u.handle, pc.name persona_name, pc.avatar persona_avatar, pc.cards_id_pk persona_id,
            CASE WHEN IFNULL(c.is_persona,0)=1 THEN 'human' ELSE 'ai' END kind,
            CASE WHEN IFNULL(c.is_persona,0)=1 THEN c.owner_users_id_fk END users_id_fk
            FROM room_members rm JOIN members m ON m.members_id_pk=rm.members_id_fk
            LEFT JOIN cards c ON c.cards_id_pk=m.cards_id_fk LEFT JOIN users u ON u.users_id_pk=c.owner_users_id_fk
            LEFT JOIN cards pc ON pc.owner_users_id_fk=u.users_id_pk AND pc.is_persona=1 WHERE rm.rooms_id_fk=?`).all(roomId);
        const lastMem = db.prepare("SELECT content text FROM memories WHERE rooms_id_fk=? AND source='auto' ORDER BY memories_id_pk DESC LIMIT 1").get(roomId);
        send(res, 200, { messages: msgs, members, lastMem });
    },
    'GET /api/stream': (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room') || 1);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (!streams.has(roomId)) streams.set(roomId, new Set());
        streams.get(roomId).add(res);
        req.on('close', () => streams.get(roomId)?.delete(res));
    },
    'POST /api/say': async (req, res, u) => {
        const b = await readBody(req);
        const cardId = b.cardId ?? db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk)?.cards_id_pk ?? null;
        const r = db.prepare(`INSERT INTO messages (rooms_id_fk,cards_id_fk,text)
            VALUES (?,?,?)`).run(b.room || 1, cardId, b.text);
        const msg = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r.lastInsertRowid);
        push(b.room || 1, { type: 'message', message: msg });
        send(res, 200, msg);
        // AI trigger policy for this room.
        const roomRow = db.prepare('SELECT ai_trigger FROM rooms WHERE rooms_id_pk=?').get(msg.rooms_id_fk);
        if (roomRow?.ai_trigger && roomRow.ai_trigger !== 'manual') {
            const ais = db.prepare(`SELECT c.*, c.cards_id_pk AS id, m.talkativeness FROM members m JOIN room_members rm ON rm.members_id_fk=m.members_id_pk JOIN cards c ON c.cards_id_pk=m.cards_id_fk
                WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 ORDER BY m.cards_id_fk`).all(msg.rooms_id_fk);
            // Talkativeness: per-member 0–100% chance to reply (named always fires).
            const roll = c => Math.random() * 100 < (c.talkativeness ?? 50);
            let picks = [];
            if (roomRow.ai_trigger === 'all') picks = ais.filter(roll);
            else if (roomRow.ai_trigger === 'named')
                picks = ais.filter(c => new RegExp('\\b' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(b.text || ''));
            else if (roomRow.ai_trigger === 'roundrobin') picks = ais.slice(0, 1);
            for (const card of picks)
                generateReply(msg.rooms_id_fk, card)
                    .then(text => {
                        if (!text?.trim()) return;
                        const r2 = db.prepare(`INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,?,?)`)
                            .run(msg.rooms_id_fk, card.id, text);
                        const m2 = db.prepare(MSG_SQL + ' WHERE m.messages_id_pk=?').get(r2.lastInsertRowid);
                        push(msg.rooms_id_fk, { type: 'message', message: m2 });
                    })
                    .catch(e => console.error('[gen]', e.message));
        }
        maybeSummarize(msg.rooms_id_fk).catch(e => console.error('[mem]', e.message));
    },
    'POST /api/room/trigger': async (req, res, u) => {
        const b = await readBody(req);
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
        if (!b.png_b64) return send(res, 400, { error: 'png_b64 required' });
        const file = `${b.room || 1}.png`;
        fs.writeFileSync(path.join(BG_DIR, file), Buffer.from(b.png_b64, 'base64'));
        db.prepare('UPDATE rooms SET bg=? WHERE rooms_id_pk=?').run(file, b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/room/background/remove': async (req, res, u) => {
        const b = await readBody(req);
        const r = db.prepare('SELECT bg FROM rooms WHERE rooms_id_pk=?').get(b.room || 1);
        if (r?.bg && fs.existsSync(path.join(BG_DIR, r.bg))) fs.unlinkSync(path.join(BG_DIR, r.bg));
        db.prepare("UPDATE rooms SET bg='' WHERE rooms_id_pk=?").run(b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/room/settings': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE rooms SET max_context=COALESCE(?,max_context) WHERE rooms_id_pk=?')
            .run(b.maxContext === undefined ? null : b.maxContext, b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/triggers': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
    db.prepare('UPDATE memories SET triggers=? WHERE memories_id_pk=?').run(b.triggers || '', id);
        send(res, 200, { ok: true });
    },
    'POST /api/memories/move': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
    db.prepare('DELETE FROM memory_cards WHERE memories_id_fk=?').run(id);
    if (b.cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, b.cardId);
        send(res, 200, { ok: true });
    },
    'POST /api/messages/delete': async (req, res, u) => {
        const b = await readBody(req);
        const m = db.prepare('SELECT rooms_id_fk FROM messages WHERE memories_id_pk=?').get(b.world_books_id_pk);
        if (!m) return send(res, 404, { error: 'no message' });
        db.prepare('DELETE FROM messages WHERE messages_id_pk=?').run(b.world_books_id_pk);
        push(m.rooms_id_fk, { type: 'delete', id: b.world_books_id_pk });
        send(res, 200, { ok: true });
    },
    'POST /api/room/memsettings': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE rooms SET auto_mem=COALESCE(?,auto_mem), mem_every=COALESCE(?,mem_every),
            mem_budget=COALESCE(?,mem_budget), mem_max=COALESCE(?,mem_max),
            mem_max_fact=COALESCE(?,mem_max_fact), mem_max_event=COALESCE(?,mem_max_event),
            mem_max_relationship=COALESCE(?,mem_max_relationship), mem_max_preference=COALESCE(?,mem_max_preference),
            mem_extraction_prompt=COALESCE(?,mem_extraction_prompt),
            mem_context_threshold=COALESCE(?,mem_context_threshold),
            mem_response_length=COALESCE(?,mem_response_length),
            mem_gen_budget=COALESCE(?,mem_gen_budget), mem_unlimited=COALESCE(?,mem_unlimited),
            mem_unified=COALESCE(?,mem_unified), mem_triggers=COALESCE(?,mem_triggers),
            mem_autotune=COALESCE(?,mem_autotune), mem_refresh=COALESCE(?,mem_refresh),
            mem_activity=COALESCE(?,mem_activity), mem_extraction_profile_id=COALESCE(?,mem_extraction_profile_id),
            mem_profiles_id_fk=COALESCE(?,mem_profiles_id_fk)
            WHERE rooms_id_pk=?`)
            .run(b.auto === undefined ? null : (b.auto ? 1 : 0), b.every, b.budget, b.max,
                b.maxFact, b.maxEvent, b.maxRel, b.maxPref,
                b.extractionPrompt, b.contextThreshold, b.responseLength,
                b.genBudget, b.unlimited, b.unified, b.triggers, b.autotune, b.refresh, b.activity, b.profileId, b.memProfile, b.room || 1);
        send(res, 200, { ok: true });
    },
    'POST /api/members/talkativeness': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE members SET talkativeness=? WHERE cards_id_fk=? AND members_id_pk IN (SELECT members_id_fk FROM room_members WHERE rooms_id_fk=?)`)
            .run(Math.max(0, Math.min(100, Number(b.value) || 0)), b.room || 1, b.cardId);
        send(res, 200, { ok: true });
    },
    'POST /api/generate': async (req, res, u) => {
        const b = await readBody(req);
        const roomId = b.room || 1;
        const npc = db.prepare(`SELECT c.*, c.cards_id_pk AS id FROM members m JOIN room_members rm ON rm.members_id_fk=m.members_id_pk JOIN cards c ON c.cards_id_pk=m.cards_id_fk
            WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 ${b.card ? 'AND c.cards_id_pk=?' : ''} ORDER BY m.cards_id_fk`).all(roomId, ...(b.card ? [b.card] : []))[0];
        if (!npc) return send(res, 404, { error: 'no AI member' });
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
        }
    },
};

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const user = auth(req);
    // Unauthenticated: /api/* is off-limits except login; static files still
    // serve so the login page (and its css/js) can load.
    const firstUser = key === 'POST /api/register' && !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (!user && url.pathname.startsWith('/api/') && key !== 'POST /api/login' && key !== 'GET /api/avatar' && key !== 'GET /api/roombg' && !firstUser)
        return send(res, 401, { error: 'auth required' });
    if (router[key]) {
        try { return await router[key](req, res, user); }
        catch (e) { console.error(`[${key}]`, e); return send(res, 500, { error: String(e?.message || e) }); }
    }
    // static
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
    if (fs.existsSync(file) && file.startsWith(PUB)) {
        const ext = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain';
        res.writeHead(200, { 'Content-Type': ext });
        return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`[rp] listening on :${PORT}`));
