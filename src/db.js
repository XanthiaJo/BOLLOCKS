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
    token TEXT PRIMARY KEY, users_id_fk INTEGER NOT NULL REFERENCES users(id),
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    members_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER REFERENCES users(id),
    kind TEXT DEFAULT 'human',           -- 'human' player | 'ai' NPC
    cards_id_fk INTEGER REFERENCES cards(id),
    talkativeness INTEGER DEFAULT 50
);
CREATE TABLE IF NOT EXISTS room_members (
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    members_id_fk INTEGER NOT NULL REFERENCES members(members_id_pk),
    UNIQUE (rooms_id_fk, members_id_fk)
);
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY, owner_users_id_fk INTEGER REFERENCES users(id),
    name TEXT NOT NULL, description TEXT DEFAULT '',
    first_message TEXT DEFAULT '',
    api_profiles_id_fk INTEGER REFERENCES api_profiles(id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
    sender_users_id_fk INTEGER REFERENCES users(id),
    cards_id_fk INTEGER REFERENCES cards(id),
    kind TEXT DEFAULT 'say',             -- say | narration | ai
    name TEXT NOT NULL, text TEXT NOT NULL,
    send_date TEXT DEFAULT (datetime('now')),
    supersedes INTEGER REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(rooms_id_fk, id);
CREATE TABLE IF NOT EXISTS world_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_users_id_fk INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS world_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
    keys TEXT DEFAULT '[]',          -- JSON array of trigger keywords
    content TEXT NOT NULL DEFAULT '',
    constant INTEGER DEFAULT 0,      -- 1 = always injected, no keyword needed
    enabled INTEGER DEFAULT 1,
    ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cards_id_fk INTEGER NOT NULL REFERENCES cards(id),
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
    content TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER NOT NULL REFERENCES users(id),
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
    const u = db.prepare('SELECT *, users_id_pk AS id FROM users WHERE handle = ? COLLATE NOCASE').get(handle);
    if (!u || !verify(password, u.salt, u.password_hash)) return null;
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (sessions_token_pk,users_id_fk) VALUES (?,?)').run(token, u.users_id_pk);
    return { token, user: u };
}
export const MSG_SQL = `SELECT m.*, m.messages_id_pk AS id,
    COALESCE(c.name, pc.name, u.handle, 'sys') name,
    CASE WHEN m.cards_id_fk IS NOT NULL THEN 'ai'
         WHEN m.sender_users_id_fk IS NOT NULL THEN 'say'
         ELSE 'sys' END kind
FROM messages m
LEFT JOIN cards c ON c.cards_id_pk=m.cards_id_fk
LEFT JOIN users u ON u.users_id_pk=m.sender_users_id_fk
LEFT JOIN cards pc ON pc.owner_users_id_fk=u.users_id_pk AND pc.is_persona=1`;

export const userForToken = t =>
    t && db.prepare('SELECT u.*, u.users_id_pk AS id FROM sessions s JOIN users u ON u.users_id_pk=s.users_id_fk WHERE s.sessions_token_pk=?').get(t);

/** The caller's active connection profile (falls back to legacy settings JSON). */
export function activeProfile(userId) {
    const p = db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE users_id_fk=? AND active=1').get(userId);
    if (p) return { ...p, apiUrl: p.api_url };
    const s = JSON.parse(db.prepare('SELECT settings FROM users WHERE users_id_pk=?').get(userId)?.settings || '{}');
    return s.apiUrl ? s : null;
}

/** Schema touch-ups for existing DBs (CREATE TABLE only applies on fresh). */
export function migrateSchema() {
    // rooms.world_book_id + duplicate world_books_id_fk are dead — junction handles links.
    for (const col of ['world_book_id','world_books_id_fk','mem_last_id','mem_profile_id','api_profiles_id_fk'])
        if (db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === col))
            db.exec('ALTER TABLE rooms DROP COLUMN ' + col);
    // Proper key naming: {table}_id_pk / {ref}_id_fk � runs first so the
    // rest of the schema + migrations see the new names.
    const REN = {
      users:{id:'users_id_pk'},
      sessions:{token:'sessions_token_pk',user_id:'users_id_fk'},
      rooms:{id:'rooms_id_pk',mem_profile_id:'api_profiles_id_fk',mem_last_id:'mem_last_messages_id'},
      members:{id:'members_id_pk',room_id:'rooms_id_fk',user_id:'users_id_fk',card_id:'cards_id_fk'},
      cards:{id:'cards_id_pk',owner_id:'owner_users_id_fk',profile_id:'api_profiles_id_fk'},
      messages:{id:'messages_id_pk',room_id:'rooms_id_fk',sender_user_id:'sender_users_id_fk',card_id:'cards_id_fk'},
      world_books:{id:'world_books_id_pk',owner_id:'owner_users_id_fk'},
      world_entries:{id:'world_entries_id_pk',book_id:'world_books_id_fk'},
      room_books:{room_id:'rooms_id_fk',book_id:'world_books_id_fk'},
      memories:{id:'memories_id_pk',card_id:'cards_id_fk',room_id:'rooms_id_fk'},
      api_profiles:{id:'api_profiles_id_pk',user_id:'users_id_fk'}};
    for (const [t,rs] of Object.entries(REN))
        for (const [old,nw] of Object.entries(rs)) {
            const cols = db.prepare('PRAGMA table_info('+t+')').all().map(c=>c.name);
            if (cols.includes(old) && !cols.includes(nw))
                db.exec('ALTER TABLE '+t+' RENAME COLUMN '+old+' TO '+nw);
        }

    const cols = db.prepare('PRAGMA table_info(cards)').all().map(c => c.name);
    // SillyTavern character-card (V2) field parity.
    const v2 = {
        api_profiles_id_fk: 'INTEGER REFERENCES api_profiles(id)',
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
        is_persona: "INTEGER DEFAULT 0",
    };
    for (const [col, def] of Object.entries(v2))
        if (!cols.includes(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${def}`);
    // World lorebook model: books own entries; rooms link to one book.
    const wcols = db.prepare('PRAGMA table_info(world_entries)').all().map(c => c.name);
    if (!wcols.includes('world_books_id_fk')) db.exec('ALTER TABLE world_entries ADD COLUMN world_books_id_fk INTEGER REFERENCES world_books(id)');
    if (!wcols.includes('comment')) db.exec("ALTER TABLE world_entries ADD COLUMN comment TEXT DEFAULT ''");
    if (!wcols.includes('keysecondary')) db.exec("ALTER TABLE world_entries ADD COLUMN keysecondary TEXT DEFAULT '[]'");
    const rcols = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!rcols.includes('ai_trigger')) db.exec("ALTER TABLE rooms ADD COLUMN ai_trigger TEXT DEFAULT 'manual'");
    if (!rcols.includes('auto_mem')) db.exec('ALTER TABLE rooms ADD COLUMN auto_mem INTEGER DEFAULT 0');
    if (!rcols.includes('mem_every')) db.exec('ALTER TABLE rooms ADD COLUMN mem_every INTEGER DEFAULT 10');
    if (!rcols.includes('mem_last_messages_id')) db.exec('ALTER TABLE rooms ADD COLUMN mem_last_messages_id INTEGER DEFAULT 0');
    if (!rcols.includes('mem_budget')) db.exec('ALTER TABLE rooms ADD COLUMN mem_budget INTEGER DEFAULT 500');
    if (!rcols.includes('mem_max')) db.exec('ALTER TABLE rooms ADD COLUMN mem_max INTEGER DEFAULT 50');
    if (!rcols.includes('max_context')) db.exec('ALTER TABLE rooms ADD COLUMN max_context INTEGER DEFAULT 0');
    const mecols = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
    if (!mecols.includes('type')) db.exec("ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'fact'");
    if (!mecols.includes('source')) db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'manual'");
    // members = entity (card/user + talkativeness); room_members = junction.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='room_members'").get()) {
        db.exec(`CREATE TABLE room_members (
            rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
            members_id_fk INTEGER NOT NULL REFERENCES members(members_id_pk),
            UNIQUE(rooms_id_fk, members_id_fk))`);
        // Move room membership out of members into the junction.
        db.exec(`INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk)
            SELECT rooms_id_fk, members_id_pk FROM members`);
        db.exec(`CREATE TABLE members_new (members_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            users_id_fk INTEGER REFERENCES users(users_id_pk),
            cards_id_fk INTEGER REFERENCES cards(cards_id_pk),
            kind TEXT NOT NULL, talkativeness INTEGER DEFAULT 50)`);
        db.exec(`INSERT INTO members_new (members_id_pk,users_id_fk,cards_id_fk,kind,talkativeness)
            SELECT members_id_pk,users_id_fk,cards_id_fk,kind,talkativeness FROM members`);
        db.exec('DROP TABLE members; ALTER TABLE members_new RENAME TO members');
    }
        if (!mecols.includes('triggers')) db.exec("ALTER TABLE memories ADD COLUMN triggers TEXT DEFAULT ''");
    // messages.name/kind are derivable (card/persona/user) — drop them.
    const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (msgCols.includes('name') || msgCols.includes('kind')) {
        db.exec(`CREATE TABLE messages_new (messages_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
            sender_users_id_fk INTEGER REFERENCES users(id),
            cards_id_fk INTEGER REFERENCES cards(id),
            text TEXT NOT NULL, send_date TEXT DEFAULT (datetime('now')),
            supersedes INTEGER)`);
        db.exec(`INSERT INTO messages_new (id,rooms_id_fk,sender_users_id_fk,cards_id_fk,text,send_date,supersedes)
            SELECT id,rooms_id_fk,sender_users_id_fk,cards_id_fk,text,send_date,supersedes FROM messages`);
        db.exec('DROP TABLE messages; ALTER TABLE messages_new RENAME TO messages');
    }
    // Entries are standalone; book_entries junction links entries to books.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='book_entries'").get()) {
        db.exec(`CREATE TABLE book_entries (
            world_books_id_fk INTEGER NOT NULL REFERENCES world_books(world_books_id_pk),
            world_entries_id_fk INTEGER NOT NULL REFERENCES world_entries(world_entries_id_pk),
            UNIQUE(world_books_id_fk, world_entries_id_fk))`);
        db.exec(`INSERT OR IGNORE INTO book_entries (world_books_id_fk,world_entries_id_fk)
            SELECT world_books_id_fk, world_entries_id_pk FROM world_entries WHERE world_books_id_fk IS NOT NULL`);
        db.exec(`CREATE TABLE world_entries_new (world_entries_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            keys TEXT DEFAULT '[]', keysecondary TEXT DEFAULT '[]',
            content TEXT DEFAULT '', constant INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1, ord INTEGER DEFAULT 0, comment TEXT DEFAULT '')`);
        db.exec(`INSERT INTO world_entries_new (world_entries_id_pk,keys,keysecondary,content,constant,enabled,ord,comment)
            SELECT world_entries_id_pk,keys,keysecondary,content,constant,enabled,ord,comment FROM world_entries`);
        db.exec('PRAGMA foreign_keys=OFF; DROP TABLE world_entries; ALTER TABLE world_entries_new RENAME TO world_entries; PRAGMA foreign_keys=ON');
    }
    // Books ↔ rooms is many-to-many — junction replaces rooms.world_books_id_fk.
    db.exec(`CREATE TABLE IF NOT EXISTS room_books (
        rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
        world_books_id_fk INTEGER NOT NULL REFERENCES world_books(id),
        UNIQUE(rooms_id_fk, world_books_id_fk))`);
    if (db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'world_books_id_fk'))
        db.exec(`INSERT OR IGNORE INTO room_books (rooms_id_fk,world_books_id_fk)
            SELECT rooms_id_pk, world_books_id_fk FROM rooms WHERE world_books_id_fk IS NOT NULL`);
    // Entries belong to books, not rooms — drop the column.
    const wecols = db.prepare('PRAGMA table_info(world_entries)').all().map(c => c.name);
    if (wecols.includes('rooms_id_fk')) {
        db.exec(`CREATE TABLE world_entries_new (world_entries_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            world_books_id_fk INTEGER NOT NULL REFERENCES world_books(id),
            keys TEXT DEFAULT '[]', keysecondary TEXT DEFAULT '[]',
            content TEXT DEFAULT '', constant INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1, ord INTEGER DEFAULT 0,
            comment TEXT DEFAULT '')`);
        db.exec(`INSERT INTO world_entries_new (id,world_books_id_fk,keys,keysecondary,content,constant,enabled,ord,comment)
            SELECT id,world_books_id_fk,keys,keysecondary,content,constant,enabled,ord,comment FROM world_entries`);
        db.exec('DROP TABLE world_entries; ALTER TABLE world_entries_new RENAME TO world_entries');
    }
    const pcols = db.prepare('PRAGMA table_info(api_profiles)').all().map(c => c.name);
    if (!pcols.includes('strip_prefix')) db.exec('ALTER TABLE api_profiles ADD COLUMN strip_prefix INTEGER DEFAULT 1');
    if (!pcols.includes('headers')) db.exec("ALTER TABLE api_profiles ADD COLUMN headers TEXT DEFAULT '{}'");
    if (!pcols.includes('context_size')) db.exec('ALTER TABLE api_profiles ADD COLUMN context_size INTEGER DEFAULT 0');
    if (!pcols.includes('max_response')) db.exec('ALTER TABLE api_profiles ADD COLUMN max_response INTEGER DEFAULT 2048');
    // Legacy room-keyed entry backfill removed — entries now belong to books
    // only; rooms link via room_books junction.
    const mcols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name);
    if (!mcols.includes('talkativeness')) db.exec('ALTER TABLE members ADD COLUMN talkativeness INTEGER DEFAULT 50');
    // memories.cards_id_fk must be nullable — NULL = shared room memory.
    const mi = db.prepare('PRAGMA table_info(memories)').all().find(c => c.name === 'cards_id_fk');
    if (mi?.notnull) db.exec(`BEGIN;
        CREATE TABLE memories_new (memories_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            cards_id_fk INTEGER REFERENCES cards(id),
            rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
            content TEXT NOT NULL, created TEXT DEFAULT (datetime('now')));
        INSERT INTO memories_new SELECT *, memories_id_pk AS id FROM memories;
        DROP TABLE memories; ALTER TABLE memories_new RENAME TO memories; COMMIT;`);
    // Duplicate-member dedupe removed — membership lives in room_members
    // junction (UNIQUE on room+member) so dupes can't form.
}

/** One-time: import legacy settings-JSON connections as a "Default" profile. */
export function migrateProfiles() {
    for (const u of db.prepare('SELECT *, users_id_pk AS id FROM users').all()) {
        const s = JSON.parse(u.settings || '{}');
        if (!s.apiUrl) continue;
        const exists = db.prepare('SELECT 1 FROM api_profiles WHERE users_id_fk=?').get(u.users_id_pk);
        if (exists) continue;
        db.prepare(`INSERT INTO api_profiles (users_id_fk,name,api_url,model,key,active)
            VALUES (?,?,?,?,?,1)`).run(u.users_id_pk, 'ST OpenRouter', s.apiUrl, s.model || '', s.key || '');
        console.log(`[db] imported connection profile for ${u.handle}`);
    }
}

export function seed() {
    // Test users — every account gets membership in room 1.
    const room = db.prepare('SELECT rooms_id_pk AS id FROM rooms ORDER BY rooms_id_pk LIMIT 1').get()?.id
        || db.prepare('INSERT INTO rooms (name) VALUES (?)').run('The House').lastInsertRowid;
    for (const h of ['creamms', 'karima', 'blake', 'entropy75']) {
        if (!db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get(h))
            createUser(h, 'changeme');
    }
    // Only auto-join the test users on a fresh install (no humans anywhere).
    const memberFor = uid => {
        let mid = db.prepare('SELECT members_id_pk FROM members WHERE users_id_fk=? AND cards_id_fk IS NULL').get(uid)?.members_id_pk;
        if (!mid) mid = db.prepare("INSERT INTO members (users_id_fk,kind) VALUES (?,'human')").run(uid).lastInsertRowid;
        return mid;
    };
    if (!db.prepare('SELECT 1 FROM members WHERE users_id_fk IS NOT NULL LIMIT 1').get()) {
        for (const h of ['creamms', 'karima', 'blake', 'entropy75']) {
            const uid = db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get(h).id;
            db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)')
                .run(room, memberFor(uid));
        }
    }
    if (db.prepare('SELECT COUNT(*) c FROM messages').get().c) return;
    const mptest = db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get('mptest')?.id;
    if (mptest) db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)')
        .run(room, memberFor(mptest));
    console.log('[db] users + room ensured');
}
