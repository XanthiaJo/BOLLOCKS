// Lorebook routes: books, entries, ST import, room linking.
import { db } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { roomOwnerOnly, worldEntryOk } from '../lib/access.js';

export default {
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
    'POST /api/world/books/update': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const r = db.prepare('UPDATE world_books SET name=? WHERE world_books_id_pk=? AND owner_users_id_fk=?')
            .run(b.name, b.id || b.world_books_id_pk, u.users_id_pk);
        if (!r.changes) return send(res, 403, { error: 'not your book' });
        send(res, 200, { ok: true });
    },
    'POST /api/world/books/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        const eids = db.prepare('SELECT world_entries_id_fk AS id FROM book_entries WHERE world_books_id_fk=?').all(id).map(r => r.id);
        db.prepare('DELETE FROM book_entries WHERE world_books_id_fk=?').run(id);
        const stillLinked = db.prepare('SELECT 1 FROM book_entries WHERE world_entries_id_fk=? LIMIT 1');
        const delE = db.prepare('DELETE FROM world_entries WHERE world_entries_id_pk=?');
        const delK = db.prepare('DELETE FROM world_entry_keys WHERE world_entries_id_fk=?');
        for (const eid of eids) {
            if (stillLinked.get(eid)) continue; // shared with another book — keep it
            delK.run(eid); delE.run(eid);
        }
        db.prepare('DELETE FROM world_books WHERE world_books_id_pk=? AND owner_users_id_fk=?').run(id, u.users_id_pk);
        db.prepare('DELETE FROM room_books WHERE world_books_id_fk=?').run(id);
        send(res, 200, { ok: true });
    },
    'POST /api/world/link': async (req, res, u) => {
        const b = await readBody(req);
        const rid = b.room || b.id || 1;
        if (!roomOwnerOnly(rid, u)) return send(res, 403, { error: 'room owner only' });
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
        if (b.book && db.prepare('SELECT owner_users_id_fk AS o FROM world_books WHERE world_books_id_pk=?').get(b.book)?.o !== u.users_id_pk)
            return send(res, 403, { error: 'not your book' });
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
        const id = b.id || b.world_books_id_pk;
        if (!worldEntryOk(id, u)) return send(res, 403, { error: 'not your entry' });
        const keys = typeof b.keys === 'string'
            ? b.keys.split(',').map(k => k.trim()).filter(Boolean) : b.keys;
        const secondary = typeof b.keysecondary === 'string'
            ? b.keysecondary.split(',').map(k => k.trim()).filter(Boolean) : b.keysecondary;
        if (keys || secondary) {
            db.prepare('DELETE FROM world_entry_keys WHERE world_entries_id_fk=?').run(id);
            const ik = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
            for (const w of (keys || [])) ik.run(id, w, 'primary');
            for (const w of (secondary || [])) ik.run(id, w, 'secondary');
        }
        db.prepare(`UPDATE world_entries SET
            comment=COALESCE(?,comment), content=COALESCE(?,content),
            constant=COALESCE(?,constant), enabled=COALESCE(?,enabled), ord=COALESCE(?,ord) WHERE world_entries_id_pk=?`)
            .run(b.comment ?? null, b.content ?? null,
                b.constant === undefined ? null : (b.constant ? 1 : 0),
                b.enabled === undefined ? null : (b.enabled ? 1 : 0), b.ord ?? null, id);
        send(res, 200, { ok: true });
    },
    'POST /api/world/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        if (!worldEntryOk(id, u)) return send(res, 403, { error: 'not your entry' });
        db.prepare('DELETE FROM world_entry_keys WHERE world_entries_id_fk=?').run(id);
        db.prepare('DELETE FROM book_entries WHERE world_entries_id_fk=?').run(id);
        db.prepare('DELETE FROM world_entries WHERE world_entries_id_pk=?').run(id);
        send(res, 200, { ok: true });
    },
};
