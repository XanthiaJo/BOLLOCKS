import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    settings TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id),
    user_id INTEGER REFERENCES users(id),
    kind TEXT DEFAULT 'human',           -- 'human' player | 'ai' NPC
    card_id INTEGER REFERENCES cards(id),
    UNIQUE (room_id, user_id, card_id)
);
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL, description TEXT DEFAULT '',
    first_message TEXT DEFAULT '',
    profile_id INTEGER REFERENCES api_profiles(id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    sender_user_id INTEGER REFERENCES users(id),
    card_id INTEGER REFERENCES cards(id),
    kind TEXT DEFAULT 'say',             -- say | narration | ai
    name TEXT NOT NULL, text TEXT NOT NULL,
    send_date TEXT DEFAULT (datetime('now')),
    supersedes INTEGER REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
CREATE TABLE IF NOT EXISTS world_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS world_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    keys TEXT DEFAULT '[]',          -- JSON array of trigger keywords
    content TEXT NOT NULL DEFAULT '',
    constant INTEGER DEFAULT 0,      -- 1 = always injected, no keyword needed
    enabled INTEGER DEFAULT 1,
    ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS api_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL DEFAULT '',
    active INTEGER DEFAULT 0
);
`);

export const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
    ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
export const verify = (pw, salt, h) =>
    crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(h, 'hex'));

export function createUser(handle, password) {
    const { salt, hash: h } = hash(password);
    return db.prepare('INSERT INTO users (handle,password_hash,salt) VALUES (?,?,?)')
        .run(handle, h, salt).lastInsertRowid;
}
export function login(handle, password) {
    const u = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
    if (!u || !verify(password, u.salt, u.password_hash)) return null;
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, u.id);
    return { token, user: u };
}
export const userForToken = t =>
    t && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t);

/** The caller's active connection profile (falls back to legacy settings JSON). */
export function activeProfile(userId) {
    const p = db.prepare('SELECT * FROM api_profiles WHERE user_id=? AND active=1').get(userId);
    if (p) return { apiUrl: p.api_url, model: p.model, key: p.key };
    const s = JSON.parse(db.prepare('SELECT settings FROM users WHERE id=?').get(userId)?.settings || '{}');
    return s.apiUrl ? s : null;
}

/** Schema touch-ups for existing DBs (CREATE TABLE only applies on fresh). */
export function migrateSchema() {
    const cols = db.prepare('PRAGMA table_info(cards)').all().map(c => c.name);
    // SillyTavern character-card (V2) field parity.
    const v2 = {
        profile_id: 'INTEGER REFERENCES api_profiles(id)',
        personality: "TEXT DEFAULT ''",
        scenario: "TEXT DEFAULT ''",
        mes_example: "TEXT DEFAULT ''",
        system_prompt: "TEXT DEFAULT ''",
        post_history_instructions: "TEXT DEFAULT ''",
        alternate_greetings: "TEXT DEFAULT '[]'",
        tags: "TEXT DEFAULT '[]'",
        creator: "TEXT DEFAULT ''",
        creatorcomment: "TEXT DEFAULT ''",
        character_version: "TEXT DEFAULT ''",
        avatar: "TEXT DEFAULT ''",
        card_json: "TEXT DEFAULT ''",
    };
    for (const [col, def] of Object.entries(v2))
        if (!cols.includes(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${def}`);
    // World lorebook model: books own entries; rooms link to one book.
    const wcols = db.prepare('PRAGMA table_info(world_entries)').all().map(c => c.name);
    if (!wcols.includes('book_id')) db.exec('ALTER TABLE world_entries ADD COLUMN book_id INTEGER REFERENCES world_books(id)');
    if (!wcols.includes('comment')) db.exec("ALTER TABLE world_entries ADD COLUMN comment TEXT DEFAULT ''");
    if (!wcols.includes('keysecondary')) db.exec("ALTER TABLE world_entries ADD COLUMN keysecondary TEXT DEFAULT '[]'");
    const rcols = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!rcols.includes('world_book_id')) db.exec('ALTER TABLE rooms ADD COLUMN world_book_id INTEGER REFERENCES world_books(id)');
    const pcols = db.prepare('PRAGMA table_info(api_profiles)').all().map(c => c.name);
    if (!pcols.includes('strip_prefix')) db.exec('ALTER TABLE api_profiles ADD COLUMN strip_prefix INTEGER DEFAULT 1');
    // Legacy: entries keyed by room become a default book linked to that room.
    for (const r of db.prepare('SELECT DISTINCT room_id FROM world_entries WHERE book_id IS NULL').all()) {
        const bid = db.prepare('INSERT INTO world_books (owner_id,name) VALUES (NULL,?)').run('Room ' + r.room_id + ' book').lastInsertRowid;
        db.prepare('UPDATE world_entries SET book_id=? WHERE room_id=? AND book_id IS NULL').run(bid, r.room_id);
        db.prepare('UPDATE rooms SET world_book_id=? WHERE id=? AND world_book_id IS NULL').run(bid, r.room_id);
    }
    // NULL-keyed UNIQUE never deduped — purge duplicate human members.
    db.exec(`DELETE FROM members WHERE id NOT IN (
        SELECT MIN(id) FROM members
        GROUP BY room_id, IFNULL(user_id,-1), IFNULL(card_id,-1))`);
}

/** One-time: import legacy settings-JSON connections as a "Default" profile. */
export function migrateProfiles() {
    for (const u of db.prepare('SELECT * FROM users').all()) {
        const s = JSON.parse(u.settings || '{}');
        if (!s.apiUrl) continue;
        const exists = db.prepare('SELECT 1 FROM api_profiles WHERE user_id=?').get(u.id);
        if (exists) continue;
        db.prepare(`INSERT INTO api_profiles (user_id,name,api_url,model,key,active)
            VALUES (?,?,?,?,?,1)`).run(u.id, 'ST OpenRouter', s.apiUrl, s.model || '', s.key || '');
        console.log(`[db] imported connection profile for ${u.handle}`);
    }
}

export function seed() {
    // Test users — every account gets membership in room 1.
    const room = db.prepare('SELECT id FROM rooms ORDER BY id LIMIT 1').get()?.id
        || db.prepare('INSERT INTO rooms (name) VALUES (?)').run('The House').lastInsertRowid;
    for (const h of ['creamms', 'karima', 'blake']) {
        if (!db.prepare('SELECT id FROM users WHERE handle=?').get(h))
            createUser(h, 'changeme');
        const uid = db.prepare('SELECT id FROM users WHERE handle=?').get(h).id;
        if (!db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=? AND card_id IS NULL').get(room, uid))
            db.prepare('INSERT INTO members (room_id,user_id,kind) VALUES (?,?,?)').run(room, uid, 'human');
    }
    if (db.prepare('SELECT COUNT(*) c FROM messages').get().c) return;
    const mptest = db.prepare('SELECT id FROM users WHERE handle=?').get('mptest')?.id;
    if (mptest) db.prepare('INSERT OR IGNORE INTO members (room_id,user_id,kind) VALUES (?,?,?)').run(room, mptest, 'human');
    console.log('[db] users + room ensured');
}
