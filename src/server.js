import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seed, login, userForToken, createUser } from './db.js';
import { generateReply } from './generate.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8100);
seed();

// ---- SSE fan-out per room ----
const streams = new Map(); // room_id -> Set<res>
const push = (roomId, evt) => {
    for (const res of streams.get(Number(roomId)) || [])
        try { res.write(`data:${JSON.stringify(evt)}\n\n`); } catch { }
};

// ---- HTTP helpers ----
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// Local testing mode: no token → first user. Swap for real auth later.
const auth = req =>
    userForToken(req.headers.authorization?.replace(/^Bearer /, '') || new URL(req.url, 'http://x').searchParams.get('token'))
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
    'GET /api/settings': async (req, res, u) => {
        const s = JSON.parse(u.settings || '{}');
        send(res, 200, { apiUrl: s.apiUrl || '', model: s.model || '', key: s.key ? '••••••' : '' });
    },
    'POST /api/settings': async (req, res, u) => {
        const b = await readBody(req);
        const s = JSON.parse(u.settings || '{}');
        if (b.apiUrl !== undefined) s.apiUrl = b.apiUrl;
        if (b.model !== undefined) s.model = b.model;
        if (b.key && b.key !== '••••••') s.key = b.key;
        db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(s), u.id);
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
