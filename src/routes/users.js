// Account profile + user admin routes.
import { db, hash, verify } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { isAdmin } from '../lib/access.js';

export default {
    'GET /api/me': async (req, res, u) => {
        const persona = db.prepare('SELECT cards_id_pk AS id,name FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(u.users_id_pk);
        send(res, 200, { handle: u.handle, email: u.email || '', persona: persona || null });
    },
    'POST /api/me/update': async (req, res, u) => {
        const b = await readBody(req);
        if (b.handle !== undefined) {
            const h = String(b.handle).trim();
            if (!h) return send(res, 400, { error: 'handle required' });
            if (db.prepare('SELECT 1 FROM users WHERE handle=? COLLATE NOCASE AND users_id_pk<>?').get(h, u.users_id_pk))
                return send(res, 409, { error: 'handle taken' });
            db.prepare('UPDATE users SET handle=? WHERE users_id_pk=?').run(h, u.users_id_pk);
        }
        if (b.email !== undefined) db.prepare('UPDATE users SET email=? WHERE users_id_pk=?').run(String(b.email).trim(), u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/me/password': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.current || !b.password) return send(res, 400, { error: 'current+new password required' });
        if (!verify(b.current, u.salt, u.password_hash)) return send(res, 403, { error: 'wrong current password' });
        const { salt, hash: h } = hash(b.password);
        db.prepare('UPDATE users SET password_hash=?, salt=? WHERE users_id_pk=?').run(h, salt, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/persona': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE cards SET is_persona=0 WHERE owner_users_id_fk=?').run(u.users_id_pk);
        if (b.cardId) db.prepare('UPDATE cards SET is_persona=1 WHERE cards_id_pk=? AND owner_users_id_fk=?').run(b.cardId, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'GET /api/users': async (req, res, u) =>
        send(res, 200, { users: db.prepare('SELECT users_id_pk AS id,handle FROM users ORDER BY users_id_pk').all() }),
    'POST /api/users/delete': async (req, res, u) => {
        const b = await readBody(req);
        if (!isAdmin(u)) return send(res, 403, { error: 'admin only' });
        const target = b.handle
            ? db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=? COLLATE NOCASE').get(b.handle)?.id
            : (b.id || b.world_books_id_pk);
        if (!target || target === u.users_id_pk) return send(res, 400, { error: 'no such user' });
        db.prepare('DELETE FROM sessions WHERE users_id_fk=?').run(target);
        db.prepare('DELETE FROM room_members WHERE members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk IN (SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=?))').run(target);
            db.prepare('DELETE FROM members WHERE cards_id_fk IN (SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=?)').run(target);
        db.prepare('DELETE FROM users WHERE users_id_pk=?').run(target);
        send(res, 200, { ok: true });
    },
};
