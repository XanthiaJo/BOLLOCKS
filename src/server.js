import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seed, login, userForToken, createUser, activeProfile, migrateProfiles, migrateSchema } from './db.js';
import { generateReply } from './generate.js';
import { extractCardJson, normalizeCard } from './pngcard.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8100);
seed();
migrateSchema();
migrateProfiles();

// ---- SSE fan-out per room ----
const streams = new Map(); // room_id -> Set<res>
const push = (roomId, evt) => {
    for (const res of streams.get(Number(roomId)) || [])
        try { res.write(`data:${JSON.stringify(evt)}\n\n`); } catch { }
};

// ---- HTTP helpers ----
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// Local testing mode: no token → ?as=<handle> impersonation, else first user.
const auth = req =>
    userForToken(req.headers.authorization?.replace(/^Bearer /, '') || new URL(req.url, 'http://x').searchParams.get('token'))
    || db.prepare('SELECT * FROM users WHERE handle=?').get(
        new URL(req.url, 'http://x').searchParams.get('as') || req.headers['x-as-user'] || '')
    || db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();

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
    'GET /api/me': async (req, res, u) => send(res, 200, { handle: u.handle }),
    'GET /api/world': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('room') || 1);
        const entries = db.prepare('SELECT * FROM world_entries WHERE room_id=? ORDER BY ord, id').all(roomId);
        send(res, 200, { entries });
    },
    'POST /api/world': async (req, res, u) => {
        const b = await readBody(req);
        const keys = typeof b.keys === 'string'
            ? b.keys.split(',').map(k => k.trim()).filter(Boolean) : (b.keys || []);
        const id = db.prepare('INSERT INTO world_entries (room_id,keys,content,constant,enabled,ord) VALUES (?,?,?,?,?,?)')
            .run(b.room || 1, JSON.stringify(keys), b.content || '', b.constant ? 1 : 0, b.enabled === false ? 0 : 1, b.ord || 0).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/world/update': async (req, res, u) => {
        const b = await readBody(req);
        const keys = typeof b.keys === 'string'
            ? JSON.stringify(b.keys.split(',').map(k => k.trim()).filter(Boolean))
            : (b.keys ? JSON.stringify(b.keys) : null);
        db.prepare(`UPDATE world_entries SET keys=COALESCE(?,keys), content=COALESCE(?,content),
            constant=COALESCE(?,constant), enabled=COALESCE(?,enabled), ord=COALESCE(?,ord) WHERE id=?`)
            .run(keys, b.content, b.constant === undefined ? null : (b.constant ? 1 : 0),
                b.enabled === undefined ? null : (b.enabled ? 1 : 0), b.ord, b.id);
        send(res, 200, { ok: true });
    },
    'POST /api/world/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM world_entries WHERE id=?').run(b.id);
        send(res, 200, { ok: true });
    },
    'GET /api/users': async (req, res, u) =>
        send(res, 200, { users: db.prepare('SELECT handle FROM users ORDER BY id').all() }),
    'GET /api/cards': async (req, res, u) => {
        // Own cards + cards in rooms shared with the caller — a non-owner
        // shouldn't even know other characters exist.
        const cards = db.prepare(`SELECT c.*, u.handle owner FROM cards c
            LEFT JOIN users u ON u.id=c.owner_id
            WHERE c.owner_id = ? OR c.id IN (
                SELECT m2.card_id FROM members m2
                JOIN members me ON me.room_id = m2.room_id AND me.user_id = ?
                WHERE m2.card_id IS NOT NULL
            ) ORDER BY c.name`).all(u.id, u.id);
        send(res, 200, { cards });
    },
    'POST /api/cards': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare(`INSERT INTO cards (owner_id,name,description,personality,scenario,first_message,
            mes_example,system_prompt,post_history_instructions,tags,creator,profile_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.id, b.name, b.description || '', b.personality || '', b.scenario || '', b.first_message || '',
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
        const id = db.prepare(`INSERT INTO cards (owner_id,name,description,personality,scenario,first_message,mes_example,
            system_prompt,post_history_instructions,alternate_greetings,tags,creator,creatorcomment,character_version,avatar,card_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.id, c.name, c.description, c.personality, c.scenario, c.first_mes, c.mes_example,
                c.system_prompt, c.post_history_instructions, JSON.stringify(c.alternate_greetings),
                JSON.stringify(c.tags), c.creator, c.creatorcomment, c.character_version, avatarPath,
                JSON.stringify(raw)).lastInsertRowid;
        send(res, 200, { id, name: c.name });
    },
    // Card avatar image.
    'GET /api/avatar': (req, res) => {
        const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
        const c = db.prepare('SELECT avatar FROM cards WHERE id=?').get(id);
        if (!c?.avatar) return send(res, 404, { error: 'no avatar' });
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', c.avatar);
        if (!fs.existsSync(file)) return send(res, 404, { error: 'no avatar file' });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(file).pipe(res);
    },
    'POST /api/cards/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE cards SET name=COALESCE(?,name), description=COALESCE(?,description),
            personality=COALESCE(?,personality), scenario=COALESCE(?,scenario),
            first_message=COALESCE(?,first_message), mes_example=COALESCE(?,mes_example),
            system_prompt=COALESCE(?,system_prompt), post_history_instructions=COALESCE(?,post_history_instructions),
            tags=COALESCE(?,tags), creator=COALESCE(?,creator), profile_id=? WHERE id=? AND owner_id=?`)
            .run(b.name, b.description, b.personality, b.scenario, b.first_message, b.mes_example,
                b.system_prompt, b.post_history_instructions,
                b.tags !== undefined ? JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : b.tags) : null,
                b.creator, b.profileId ?? null, b.id, u.id);
        send(res, 200, { ok: true });
    },
    'POST /api/cards/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM cards WHERE id=? AND owner_id=?').run(b.id, u.id);
        db.prepare('DELETE FROM members WHERE card_id=?').run(b.id);
        send(res, 200, { ok: true });
    },
    'POST /api/members': async (req, res, u) => {
        const b = await readBody(req);
        // Only the owner may place a character into a room.
        const card = db.prepare('SELECT owner_id FROM cards WHERE id=?').get(b.cardId);
        if (!card) return send(res, 404, { error: 'card not found' });
        if (card.owner_id !== u.id) return send(res, 403, { error: 'not your character' });
        db.prepare('INSERT INTO members (room_id,card_id,kind) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM members WHERE room_id=? AND card_id=?)')
            .run(b.room || 1, b.cardId, b.kind || 'ai', b.room || 1, b.cardId);
        send(res, 200, { ok: true });
    },
    'POST /api/members/remove': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM members WHERE card_id=? AND room_id=?').run(b.cardId, b.room || 1);
        send(res, 200, { ok: true });
    },
    'GET /api/rooms': async (req, res, u) => {
        const rooms = db.prepare(`SELECT r.id, r.name FROM rooms r
            JOIN members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY r.id`).all(u.id);
        send(res, 200, { rooms });
    },
    'POST /api/rooms': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare('INSERT INTO rooms (name) VALUES (?)').run(b.name).lastInsertRowid;
        db.prepare('INSERT INTO members (room_id,user_id,kind) VALUES (?,?,?)').run(id, u.id, 'human');
        send(res, 200, { id, name: b.name });
    },
    'GET /api/profiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT id,name,api_url,model,active,(key!=\'\') has_key FROM api_profiles WHERE user_id=? ORDER BY id').all(u.id);
        send(res, 200, { profiles });
    },
    'POST /api/profiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const first = !db.prepare('SELECT 1 FROM api_profiles WHERE user_id=?').get(u.id);
        const id = db.prepare('INSERT INTO api_profiles (user_id,name,api_url,model,key,active) VALUES (?,?,?,?,?,?)')
            .run(u.id, b.name, b.apiUrl || '', b.model || '', b.key || '', first ? 1 : 0).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/profiles/update': async (req, res, u) => {
        const b = await readBody(req);
        const sets = ['name=?', 'api_url=?', 'model=?'];
        const args = [b.name, b.apiUrl, b.model];
        if (b.key) { sets.push('key=?'); args.push(b.key); }
        args.push(b.id, u.id);
        db.prepare(`UPDATE api_profiles SET ${sets.join(',')} WHERE id=? AND user_id=?`).run(...args);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/activate': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE api_profiles SET active=0 WHERE user_id=?').run(u.id);
        db.prepare('UPDATE api_profiles SET active=1 WHERE id=? AND user_id=?').run(b.id, u.id);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM api_profiles WHERE id=? AND user_id=?').run(b.id, u.id);
        send(res, 200, { ok: true });
    },
    'GET /api/room': async (req, res, u) => {
        const roomId = Number(new URL(req.url, 'http://x').searchParams.get('id') || 1);
        const msgs = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY id').all(roomId);
        const members = db.prepare(`SELECT m.*, c.name card_name, u.handle FROM members m
            LEFT JOIN cards c ON c.id=m.card_id LEFT JOIN users u ON u.id=m.user_id WHERE m.room_id=?`).all(roomId);
        send(res, 200, { messages: msgs, members });
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
        const cardId = b.cardId ?? null;
        const name = b.name || u.handle;
        const r = db.prepare(`INSERT INTO messages (room_id,sender_user_id,card_id,name,text)
            VALUES (?,?,?,?,?)`).run(b.room || 1, u.id, cardId, name, b.text);
        const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
        push(b.room || 1, { type: 'message', message: msg });
        send(res, 200, msg);
    },
    'POST /api/generate': async (req, res, u) => {
        const b = await readBody(req);
        const roomId = b.room || 1;
        const npc = db.prepare(`SELECT c.* FROM members m JOIN cards c ON c.id=m.card_id
            WHERE m.room_id=? AND m.kind='ai' ${b.card ? 'AND c.id=?' : ''} ORDER BY m.card_id`).all(roomId, ...(b.card ? [b.card] : []))[0];
        if (!npc) return send(res, 404, { error: 'no AI member' });
        try {
            const text = await generateReply(roomId, npc);
            const r = db.prepare(`INSERT INTO messages (room_id,card_id,name,text,kind) VALUES (?,?,?,?,'ai')`)
                .run(roomId, npc.id, npc.name, text);
            const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
            push(roomId, { type: 'message', message: msg });
            send(res, 200, msg);
        } catch (err) {
            send(res, 500, { error: String(err?.message || err) });
        }
    },
};

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const user = auth(req);
    if (!user) return send(res, 401, { error: 'auth required' });
    if (router[key]) return router[key](req, res, user);
    // static
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
    if (fs.existsSync(file) && file.startsWith(PUB)) {
        const ext = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain';
        res.writeHead(200, { 'Content-Type': ext });
        return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`[rp] listening on :${PORT}`));
