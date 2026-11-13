// Session + account routes: login/logout/register.
import { db, login, createUser } from '../db.js';
import { send, readBody, cookieToken } from '../lib/util.js';
import { isAdmin } from '../lib/access.js';

export default {
    'POST /api/login': async (req, res) => {
        const b = await readBody(req);
        if (!b.handle || !b.password) return send(res, 400, { error: 'handle+password required' });
        const s = login(b.handle, b.password);
        if (!s) return send(res, 401, { error: 'bad credentials' });
        res.setHeader('Set-Cookie', `mp_token=${s.token}; Path=/; HttpOnly; SameSite=Lax`);
        send(res, 200, { token: s.token, handle: s.user.handle });
    },
    'GET /api/logout': (req, res) => {
        const t = req.headers.authorization?.replace(/^Bearer /, '') || cookieToken(req) || new URL(req.url, 'http://x').searchParams.get('token');
        if (t) db.prepare('DELETE FROM sessions WHERE sessions_token_pk=?').run(t);
        res.writeHead(302, { Location: '/login.html', 'Set-Cookie': 'mp_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
        res.end();
    },
    'POST /api/register': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.handle || !b.password) return send(res, 400, { error: 'handle+password required' });
        // First user bootstraps the site; after that only the admin may add accounts.
        if (db.prepare('SELECT 1 FROM users').get() && !isAdmin(u)) return send(res, 403, { error: 'admin only' });
        // NOCASE pre-check — the UNIQUE constraint is binary, but login matches
        // case-insensitively, so a case-variant handle would be unloginable.
        if (db.prepare('SELECT 1 FROM users WHERE handle=? COLLATE NOCASE').get(b.handle))
            return send(res, 409, { error: 'handle taken' });
        try { send(res, 200, { id: createUser(b.handle, b.password) }); }
        catch { send(res, 409, { error: 'handle taken' }); }
    },
};
