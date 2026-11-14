import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { identiconPng } from './lib/identicon.js';

export const DATA_DIR = path.resolve(process.env.BOLLOCKS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
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
CREATE TABLE IF NOT EXISTS room_members (
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
    talkativeness INTEGER DEFAULT 50,
    UNIQUE (rooms_id_fk, cards_id_fk)
);
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY, owner_users_id_fk INTEGER REFERENCES users(id),
    name TEXT NOT NULL, description TEXT DEFAULT '',
    first_message TEXT DEFAULT '',
    api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
    cards_id_fk INTEGER REFERENCES cards(id),
    text TEXT NOT NULL,
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
    world_entries_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL DEFAULT '',
    constant INTEGER DEFAULT 0,      -- 1 = always injected, no keyword needed
    enabled INTEGER DEFAULT 1,
    ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now')),
    type TEXT DEFAULT 'fact',
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','smart')),
    triggers TEXT DEFAULT ''
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
CREATE TABLE IF NOT EXISTS mem_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
    name TEXT NOT NULL,
    auto_mem INTEGER DEFAULT 0,
    mem_every INTEGER DEFAULT 10,
    mem_budget INTEGER DEFAULT 800,
    mem_max INTEGER DEFAULT 50,
    mem_max_fact INTEGER DEFAULT 15,
    mem_max_event INTEGER DEFAULT 15,
    mem_max_relationship INTEGER DEFAULT 15,
    mem_max_preference INTEGER DEFAULT 15,
    mem_extraction_prompt TEXT DEFAULT '',
    mem_context_threshold INTEGER DEFAULT 80,
    mem_response_length INTEGER DEFAULT 2000,
    mem_gen_budget INTEGER DEFAULT 2000,
    mem_unlimited INTEGER DEFAULT 0,
    mem_unified INTEGER DEFAULT 1,
    mem_triggers INTEGER DEFAULT 1,
    mem_autotune INTEGER DEFAULT 0,
    mem_refresh INTEGER DEFAULT 1,
    mem_activity INTEGER DEFAULT 0,
    mem_extraction_profile_id INTEGER DEFAULT 0
);
`);

export const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
    ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
export const verify = (pw, salt, h) =>
    crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(h, 'hex'));

export function createUser(handle, password) {
    const { salt, hash: h } = hash(password);
    const id = db.prepare('INSERT INTO users (handle,password_hash,salt) VALUES (?,?,?)')
        .run(handle, h, salt).lastInsertRowid;
    db.prepare("INSERT INTO prompt_profiles (users_id_fk,name,active) VALUES (?,'Default',1)").run(id);
    return id;
}
export function login(handle, password) {
    const u = db.prepare('SELECT *, users_id_pk AS id FROM users WHERE handle = ? COLLATE NOCASE').get(handle);
    if (!u || !verify(password, u.salt, u.password_hash)) return null;
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (sessions_token_pk,users_id_fk) VALUES (?,?)').run(token, u.users_id_pk);
    return { token, user: u };
}
export const MSG_SQL = `SELECT m.*, m.messages_id_pk AS id,
    COALESCE(c.name, 'sys') name,
    CASE WHEN m.cards_id_fk IS NULL THEN 'sys'
         WHEN c.is_persona=1 THEN 'say'
         ELSE 'ai' END kind
FROM messages m
LEFT JOIN cards c ON c.cards_id_pk=m.cards_id_fk`;

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
    const ccols2 = db.prepare('PRAGMA table_info(cards)').all().map(c => c.name);
    if (ccols2.includes('profile_id')) db.exec('ALTER TABLE cards DROP COLUMN profile_id');
    if (!ccols2.includes('api_profiles_id_fk')) db.exec('ALTER TABLE cards ADD COLUMN api_profiles_id_fk INTEGER');
    // Older builds declared cards.api_profiles_id_fk -> api_profiles(id), which no
    // longer exists after the PK rename — any write to it fails "foreign key
    // mismatch". Rebuild cards with the corrected FK when that signature shows.
    const cardSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cards'").get()?.sql || '';
    if (cardSql.includes('REFERENCES api_profiles(id)')) {
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec(`BEGIN;
            CREATE TABLE cards_new (cards_id_pk INTEGER PRIMARY KEY, owner_users_id_fk INTEGER REFERENCES users(users_id_pk),
                name TEXT NOT NULL, description TEXT DEFAULT '', first_message TEXT DEFAULT '',
                personality TEXT DEFAULT '', scenario TEXT DEFAULT '', mes_example TEXT DEFAULT '',
                system_prompt TEXT DEFAULT '', post_history_instructions TEXT DEFAULT '',
                alternate_greetings TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', creator TEXT DEFAULT '',
                creatorcomment TEXT DEFAULT '', character_version TEXT DEFAULT '', avatar TEXT DEFAULT '',
                card_json TEXT DEFAULT '', is_persona INTEGER DEFAULT 0,
                api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk));
            INSERT INTO cards_new SELECT cards_id_pk, owner_users_id_fk, name, description, first_message,
                personality, scenario, mes_example, system_prompt, post_history_instructions,
                alternate_greetings, tags, creator, creatorcomment, character_version, avatar,
                card_json, is_persona, api_profiles_id_fk FROM cards;
            DROP TABLE cards; ALTER TABLE cards_new RENAME TO cards; COMMIT;`);
        db.exec('PRAGMA foreign_keys=ON');
    }
    // rooms.world_book_id + duplicate world_books_id_fk are dead — junction handles links.
    for (const col of ['world_book_id','world_books_id_fk','mem_last_id','mem_profile_id','api_profiles_id_fk'])
        if (db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === col))
            db.exec('ALTER TABLE rooms DROP COLUMN ' + col);
    if (db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'sender_users_id_fk'))
        db.exec('ALTER TABLE messages DROP COLUMN sender_users_id_fk');
    // Proper key naming: {table}_id_pk / {ref}_id_fk � runs first so the
    // rest of the schema + migrations see the new names.
    const REN = {
      users:{id:'users_id_pk'},
      sessions:{token:'sessions_token_pk',user_id:'users_id_fk'},
      rooms:{id:'rooms_id_pk',mem_profile_id:'api_profiles_id_fk',mem_last_id:'mem_last_messages_id'},
      members:{id:'members_id_pk',room_id:'rooms_id_fk',user_id:'users_id_fk',card_id:'cards_id_fk'},
      cards:{id:'cards_id_pk',owner_id:'owner_users_id_fk',profile_id:'api_profiles_id_fk'},
      messages:{id:'messages_id_pk',room_id:'rooms_id_fk',card_id:'cards_id_fk'},
      world_books:{id:'world_books_id_pk',owner_id:'owner_users_id_fk'},
      world_entries:{id:'world_entries_id_pk',book_id:'world_books_id_fk'},
      room_books:{room_id:'rooms_id_fk',book_id:'world_books_id_fk'},
      memories:{id:'memories_id_pk'},
      mem_profiles:{id:'mem_profiles_id_pk'},
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
        api_profiles_id_fk: 'INTEGER REFERENCES api_profiles(api_profiles_id_pk)',
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
    const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!ucols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");
    // World lorebook model: books own entries; rooms link to one book.
    const wcols = db.prepare('PRAGMA table_info(world_entries)').all().map(c => c.name);
    if (!wcols.includes('world_books_id_fk')) db.exec('ALTER TABLE world_entries ADD COLUMN world_books_id_fk INTEGER REFERENCES world_books(world_books_id_pk)');
    if (!wcols.includes('comment')) db.exec("ALTER TABLE world_entries ADD COLUMN comment TEXT DEFAULT ''");
    if (!wcols.includes('keysecondary')) db.exec("ALTER TABLE world_entries ADD COLUMN keysecondary TEXT DEFAULT '[]'");
    if (!wcols.includes('keys')) db.exec("ALTER TABLE world_entries ADD COLUMN keys TEXT DEFAULT '[]'");
    const rcols = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!rcols.includes('ai_trigger')) db.exec("ALTER TABLE rooms ADD COLUMN ai_trigger TEXT DEFAULT 'manual'");
    if (!rcols.includes('bg')) db.exec("ALTER TABLE rooms ADD COLUMN bg TEXT DEFAULT ''");
    if (!rcols.includes('mem_last_messages_id')) db.exec('ALTER TABLE rooms ADD COLUMN mem_last_messages_id INTEGER DEFAULT 0');
    if (!rcols.includes('mem_refresh_count')) db.exec('ALTER TABLE rooms ADD COLUMN mem_refresh_count INTEGER DEFAULT 0');
    if (!rcols.includes('mem_profiles_id_fk')) db.exec('ALTER TABLE rooms ADD COLUMN mem_profiles_id_fk INTEGER DEFAULT 0');
    if (!rcols.includes('max_context')) db.exec('ALTER TABLE rooms ADD COLUMN max_context INTEGER DEFAULT 0');
    // One-time: sensible memory defaults — unified injection on by default,
    // and a tighter extraction generation budget (extraction only emits a
    // handful of bullets; the old 8192 default was far more headroom than
    // any extraction response needs). Guarded by a PRAGMA user_version bump.
    const uv = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (uv < 2) {
        if (rcols.includes('mem_unified')) db.exec('UPDATE rooms SET mem_unified=1');
        if (rcols.includes('mem_gen_budget')) db.exec('UPDATE rooms SET mem_gen_budget=2000 WHERE mem_gen_budget=8192');
        db.exec('UPDATE mem_profiles SET mem_unified=1, mem_gen_budget=2000 WHERE mem_gen_budget=8192');
    }
    // One-time: every chat always follows a memory profile (no per-chat custom
    // settings). Seed a Default profile if any users exist, then point any room
    // that isn't following one at the first available profile.
    if (uv < 3) {
        // Legacy DBs: mem_profiles was created referencing users(id) — stale
        // after users' PK was renamed to users_id_pk, which breaks every insert
        // into it. Rebuild with a valid FK when the mismatch is present.
        const mpfk = db.prepare('PRAGMA foreign_key_list(mem_profiles)').all();
        if (mpfk.find(f => f.table === 'users' && f.to === 'id')) {
            db.exec(`CREATE TABLE mem_profiles_new (
                mem_profiles_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
                users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
                name TEXT NOT NULL,
                auto_mem INTEGER DEFAULT 0,
                mem_every INTEGER DEFAULT 10,
                mem_budget INTEGER DEFAULT 800,
                mem_max INTEGER DEFAULT 50,
                mem_max_fact INTEGER DEFAULT 15,
                mem_max_event INTEGER DEFAULT 15,
                mem_max_relationship INTEGER DEFAULT 15,
                mem_max_preference INTEGER DEFAULT 15,
                mem_extraction_prompt TEXT DEFAULT '',
                mem_context_threshold INTEGER DEFAULT 80,
                mem_response_length INTEGER DEFAULT 2000,
                mem_gen_budget INTEGER DEFAULT 2000,
                mem_unlimited INTEGER DEFAULT 0,
                mem_unified INTEGER DEFAULT 1,
                mem_triggers INTEGER DEFAULT 1,
                mem_autotune INTEGER DEFAULT 0,
                mem_refresh INTEGER DEFAULT 1,
                mem_activity INTEGER DEFAULT 0,
                mem_extraction_profile_id INTEGER DEFAULT 0
            );
            INSERT INTO mem_profiles_new SELECT * FROM mem_profiles;
            PRAGMA foreign_keys=OFF; DROP TABLE mem_profiles; ALTER TABLE mem_profiles_new RENAME TO mem_profiles; PRAGMA foreign_keys=ON;`);
            console.log('[db] rebuilt mem_profiles with valid users FK');
        }
        if (!db.prepare('SELECT 1 FROM mem_profiles LIMIT 1').get()) {
            const uid = db.prepare('SELECT users_id_pk AS id FROM users ORDER BY users_id_pk LIMIT 1').get()?.id;
            if (uid) {
                db.prepare("INSERT INTO mem_profiles (users_id_fk,name,mem_unified) VALUES (?,'Default',1)").run(uid);
                console.log('[db] seeded Default memory profile');
            }
        }
        db.exec('UPDATE rooms SET mem_profiles_id_fk=(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1) WHERE mem_profiles_id_fk IS NULL OR mem_profiles_id_fk=0');
    }
    // One-time: memory-profile settings now live only on mem_profiles — drop the
    // per-room copies (rooms keep only the profile FK and their private
    // extraction cursor / refresh counter).
    if (uv < 4) {
        const rcolsNow = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
        const DROP = ['auto_mem', 'mem_every', 'mem_budget', 'mem_max', 'mem_max_fact',
            'mem_max_event', 'mem_max_relationship', 'mem_max_preference',
            'mem_extraction_prompt', 'mem_context_threshold', 'mem_response_length',
            'mem_gen_budget', 'mem_unlimited', 'mem_unified', 'mem_triggers',
            'mem_autotune', 'mem_refresh', 'mem_activity', 'mem_extraction_profile_id'];
        for (const c of DROP) if (rcolsNow.includes(c)) db.exec(`ALTER TABLE rooms DROP COLUMN ${c}`);
    }
    // One-time: auto-tune is shelved (the UI control is disabled) — force it
    // off on every profile so it stops running server-side too.
    if (uv < 5) db.exec('UPDATE mem_profiles SET mem_autotune=0');
    // One-time: the extraction parser used to store the "(triggers: …)" label
    // inside the triggers column itself — strip it so it isn't injected as a
    // keyword or shown on memory cards.
    if (uv < 6) {
        for (const r of db.prepare("SELECT memories_id_pk AS id, triggers FROM memories WHERE triggers LIKE '%:%'").all()) {
            const clean = r.triggers.split(',').map(s => s.trim().replace(/^triggers?\s*:/i, '').toLowerCase()).filter(Boolean).join(',');
            if (clean !== r.triggers) db.prepare('UPDATE memories SET triggers=? WHERE memories_id_pk=?').run(clean, r.id);
        }
    }
    if (uv !== 6) db.exec('PRAGMA user_version=6');
    const mecols = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
    if (!mecols.includes('type')) db.exec("ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'fact'");
    if (!mecols.includes('source')) db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'manual'");
    // prompt_profiles: injection/prompt-assembly presets. prompt order moved
    // off mem_profiles — it positions card/world blocks too, so it was never
    // memory-scoped. The user's active profile applies to all their
    // generations regardless of which API connection is used.
    const mpcols = db.prepare('PRAGMA table_info(mem_profiles)').all().map(c => c.name);
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_profiles'").get()) {
        db.exec(`CREATE TABLE prompt_profiles (
            prompt_profiles_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
            name TEXT NOT NULL,
            prompt_order TEXT,
            active INTEGER DEFAULT 0)`);
        for (const u of db.prepare('SELECT users_id_pk FROM users').all()) {
            const old = mpcols.includes('mem_prompt_order')
                ? db.prepare('SELECT mem_prompt_order FROM mem_profiles WHERE users_id_fk=? AND mem_prompt_order IS NOT NULL ORDER BY mem_profiles_id_pk LIMIT 1').get(u.users_id_pk)
                : null;
            db.prepare("INSERT INTO prompt_profiles (users_id_fk,name,prompt_order,active) VALUES (?,'Default',?,1)")
                .run(u.users_id_pk, old?.mem_prompt_order || null);
        }
    }
    if (mpcols.includes('mem_prompt_order')) db.exec('ALTER TABLE mem_profiles DROP COLUMN mem_prompt_order');
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
    // members = a card in a room; kind/users_id_fk derive from the card.
    if (db.prepare('PRAGMA table_info(members)').all().some(c => c.name === 'users_id_fk')) {
        // human members get their owner's persona card (create one if needed)
        for (const m of db.prepare('SELECT members_id_pk,users_id_fk FROM members WHERE users_id_fk IS NOT NULL').all()) {
            let pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(m.users_id_fk)?.cards_id_pk;
            if (!pc) {
                const h = db.prepare('SELECT handle FROM users WHERE users_id_pk=?').get(m.users_id_fk)?.handle || 'user';
                pc = db.prepare("INSERT INTO cards (owner_users_id_fk,name,description,is_persona) VALUES (?,?,?,1)")
                    .run(m.users_id_fk, h, '').lastInsertRowid;
            }
            db.prepare('UPDATE members SET cards_id_fk=? WHERE members_id_pk=?').run(pc, m.members_id_pk);
        }
        db.exec(`CREATE TABLE members_new2 (members_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
            talkativeness INTEGER DEFAULT 50)`);
        db.exec(`INSERT INTO members_new2 (members_id_pk,cards_id_fk,talkativeness)
            SELECT members_id_pk,cards_id_fk,talkativeness FROM members WHERE cards_id_fk IS NOT NULL`);
        db.exec('PRAGMA foreign_keys=OFF; DROP TABLE members; ALTER TABLE members_new2 RENAME TO members; PRAGMA foreign_keys=ON');
    }
    // messages.name/kind are derivable (card/persona/user) — drop them.
    const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (msgCols.includes('name') || msgCols.includes('kind')) {
        db.exec(`CREATE TABLE messages_new (messages_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            rooms_id_fk INTEGER NOT NULL REFERENCES rooms(id),
            cards_id_fk INTEGER REFERENCES cards(id),
            text TEXT NOT NULL, send_date TEXT DEFAULT (datetime('now')),
            supersedes INTEGER)`);
        db.exec(`INSERT INTO messages_new (id,rooms_id_fk,cards_id_fk,text,send_date,supersedes)
            SELECT id,rooms_id_fk,cards_id_fk,text,send_date,supersedes FROM messages`);
        db.exec('DROP TABLE messages; ALTER TABLE messages_new RENAME TO messages');
    }
    // Keywords get their own table — keys=primary triggers, keysecondary=secondary.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_entry_keys'").get()) {
        db.exec(`CREATE TABLE world_entry_keys (
            world_entries_id_fk INTEGER NOT NULL REFERENCES world_entries(world_entries_id_pk),
            word TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'primary' CHECK(kind IN ('primary','secondary')),
            UNIQUE(world_entries_id_fk, word, kind))`);
        const ekeys = db.prepare('SELECT world_entries_id_pk, keys, keysecondary FROM world_entries').all();
        const ik = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
        for (const e of ekeys) {
            for (const w of JSON.parse(e.keys || '[]')) ik.run(e.world_entries_id_pk, w, 'primary');
            for (const w of JSON.parse(e.keysecondary || '[]')) ik.run(e.world_entries_id_pk, w, 'secondary');
        }
        db.exec(`CREATE TABLE world_entries_new3 (world_entries_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            keys TEXT DEFAULT '[]', keysecondary TEXT DEFAULT '[]',
            world_books_id_fk INTEGER REFERENCES world_books(world_books_id_pk),
            content TEXT DEFAULT '', constant INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1, ord INTEGER DEFAULT 0, comment TEXT DEFAULT '')`);
        db.exec(`INSERT INTO world_entries_new3 (world_entries_id_pk,keys,keysecondary,world_books_id_fk,content,constant,enabled,ord,comment)
            SELECT world_entries_id_pk,keys,keysecondary,world_books_id_fk,content,constant,enabled,ord,comment FROM world_entries`);
        db.exec('PRAGMA foreign_keys=OFF; DROP TABLE world_entries; ALTER TABLE world_entries_new3 RENAME TO world_entries; PRAGMA foreign_keys=ON');
    }
    // Existing tables predate the CHECK — rebuild to enforce it.
    const wek = db.prepare("SELECT sql FROM sqlite_master WHERE name='world_entry_keys'").get();
    if (wek && !wek.sql.includes('CHECK')) {
        db.exec(`PRAGMA foreign_keys=OFF;
            CREATE TABLE wek2 (world_entries_id_fk INTEGER NOT NULL REFERENCES world_entries(world_entries_id_pk),
                word TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'primary' CHECK(kind IN ('primary','secondary')),
                UNIQUE(world_entries_id_fk, word, kind));
            INSERT INTO wek2 SELECT * FROM world_entry_keys;
            DROP TABLE world_entry_keys; ALTER TABLE wek2 RENAME TO world_entry_keys;
            PRAGMA foreign_keys=ON`);
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
        rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
        world_books_id_fk INTEGER NOT NULL REFERENCES world_books(world_books_id_pk),
        UNIQUE(rooms_id_fk, world_books_id_fk))`);
    // room_books was first created pointing at rooms(id)/world_books(id), which no
    // longer exist after the pk renames — every insert failed with "foreign key mismatch".
    const rbSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_books'").get()?.sql || '';
    if (rbSql.includes('REFERENCES rooms(id)') || rbSql.includes('REFERENCES world_books(id)')) {
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec(`BEGIN;
            CREATE TABLE room_books_new (
                rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
                world_books_id_fk INTEGER NOT NULL REFERENCES world_books(world_books_id_pk),
                UNIQUE(rooms_id_fk, world_books_id_fk));
            INSERT OR IGNORE INTO room_books_new (rooms_id_fk, world_books_id_fk)
                SELECT rooms_id_fk, world_books_id_fk FROM room_books;
            DROP TABLE room_books; ALTER TABLE room_books_new RENAME TO room_books; COMMIT;`);
        db.exec('PRAGMA foreign_keys=ON');
    }
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
    if (mcols.length && !mcols.includes('talkativeness')) db.exec('ALTER TABLE members ADD COLUMN talkativeness INTEGER DEFAULT 50');
    // memories.cards_id_fk must be nullable — NULL = shared room memory.
    const mecols2 = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
    const hasCardsFk = mecols2.includes('cards_id_fk');
    const hasRoomsFk = mecols2.includes('rooms_id_fk');
    const hasSource = mecols2.includes('source');
    // Collect card-scoped rows and room links before dropping columns.
    const cardScoped = hasCardsFk
        ? db.prepare('SELECT memories_id_pk, cards_id_fk FROM memories WHERE cards_id_fk IS NOT NULL').all()
        : [];
    // Collect from existing memory_cards junction (junction-era DBs), handling
    // both old (memory_id_fk) and new (memories_id_fk) column names.
    let existingCardLinks = [];
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_cards'").get()) {
        const mcCols = db.prepare('PRAGMA table_info(memory_cards)').all().map(c => c.name);
        const memCol = mcCols.includes('memories_id_fk') ? 'memories_id_fk' : 'memory_id_fk';
        existingCardLinks = db.prepare(`SELECT ${memCol} AS memory_id_fk, cards_id_fk FROM memory_cards`).all();
    }
    const roomLinks = hasRoomsFk
        ? db.prepare('SELECT memories_id_pk, rooms_id_fk FROM memories').all()
        : (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='room_memories'").get()
            ? db.prepare('SELECT memories_id_fk AS memories_id_pk, rooms_id_fk FROM room_memories').all()
            : []);
    // Fix stale memory_cards FK (older builds referenced memories(id)).
    const mcSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_cards'").get()?.sql || '';
    if (mcSql && mcSql.includes('memories(id)')) {
        db.exec('CREATE TABLE IF NOT EXISTS memory_cards_backup (memory_id_fk INTEGER, cards_id_fk INTEGER)');
        db.exec('INSERT INTO memory_cards_backup (memory_id_fk, cards_id_fk) SELECT memory_id_fk, cards_id_fk FROM memory_cards');
        db.exec('DROP TABLE memory_cards');
        db.exec(`CREATE TABLE memory_cards (
            memory_id_fk INTEGER PRIMARY KEY REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
            cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk))`);
        db.exec('INSERT OR IGNORE INTO memory_cards (memory_id_fk, cards_id_fk) SELECT memory_id_fk, cards_id_fk FROM memory_cards_backup');
        db.exec('DROP TABLE memory_cards_backup');
    }
    // Rebuild memories: drop cards_id_fk + rooms_id_fk, replace source with origin.
    if (hasCardsFk || hasRoomsFk || hasSource) {
        // Older builds can re-add `source` alongside `origin` — prefer an
        // existing origin so smart rows aren't flattened back to 'user'.
        const hasOrigin = mecols2.includes('origin');
        const smartCond = [hasOrigin && "origin='smart'", hasSource && "source='auto'"]
            .filter(Boolean).join(' OR ') || '0';
        const triggersExpr = mecols2.includes('triggers') ? 'triggers' : "''";
        db.exec(`BEGIN;
            CREATE TABLE memories_new (memories_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL, created TEXT DEFAULT (datetime('now')),
                type TEXT DEFAULT 'fact', origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','smart')),
                triggers TEXT DEFAULT '');
            INSERT INTO memories_new (memories_id_pk,content,created,type,origin,triggers)
                SELECT memories_id_pk, content, created, type,
                    CASE WHEN ${smartCond} THEN 'smart' ELSE 'user' END,
                    ${triggersExpr} FROM memories;
            DROP TABLE memories; ALTER TABLE memories_new RENAME TO memories; COMMIT;`);
    } else if (!mecols2.includes('origin')) {
        // Fresh-ish DB without origin column (shouldn't happen, but be safe).
        db.exec("ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','smart'))");
    }
    // Create junction tables (after memories rebuild).
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='room_memories'").get()) {
        db.exec(`CREATE TABLE room_memories (
            rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
            memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
            PRIMARY KEY (rooms_id_fk, memories_id_fk))`);
    }
    const mcColsNow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_cards'").get()
        ? db.prepare('PRAGMA table_info(memory_cards)').all().map(c => c.name)
        : [];
    if (mcColsNow.length && !mcColsNow.includes('memories_id_fk')) {
        db.exec('DROP TABLE memory_cards');
    }
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_cards'").get()) {
        db.exec(`CREATE TABLE memory_cards (
            memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
            cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
            PRIMARY KEY (memories_id_fk, cards_id_fk))`);
    }
    // Migrate room links.
    if (roomLinks.length) {
        const ins = db.prepare('INSERT OR IGNORE INTO room_memories (rooms_id_fk, memories_id_fk) VALUES (?,?)');
        for (const r of roomLinks) ins.run(r.rooms_id_fk, r.memories_id_pk);
    }
    // Safety net: any memory without a room link (e.g. after a partial migration)
    // is attached to the only room if there's exactly one room in the DB.
    const orphanMems = db.prepare(`SELECT m.memories_id_pk FROM memories m
        WHERE NOT EXISTS (SELECT 1 FROM room_memories rm WHERE rm.memories_id_fk=m.memories_id_pk)`).all();
    const rooms = db.prepare('SELECT rooms_id_pk FROM rooms').all();
    if (orphanMems.length && rooms.length === 1) {
        const ins = db.prepare('INSERT OR IGNORE INTO room_memories (rooms_id_fk, memories_id_fk) VALUES (?,?)');
        for (const m of orphanMems) ins.run(rooms[0].rooms_id_pk, m.memories_id_pk);
    }
    // Migrate card links (from old column and/or stale junction).
    const insCard = db.prepare('INSERT OR IGNORE INTO memory_cards (memories_id_fk, cards_id_fk) VALUES (?,?)');
    for (const r of cardScoped) insCard.run(r.memories_id_pk, r.cards_id_fk);
    for (const r of existingCardLinks) insCard.run(r.memory_id_fk, r.cards_id_fk);
    // Duplicate-member dedupe removed — membership lives in room_members
    // junction (UNIQUE on room+member) so dupes can't form.
    // Collapse members into room_members: talkativeness becomes per-room.
    if (db.prepare('PRAGMA table_info(room_members)').all().some(c => c.name === 'members_id_fk')) {
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec(`BEGIN;
            CREATE TABLE room_members_new (
                rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
                cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
                talkativeness INTEGER DEFAULT 50,
                PRIMARY KEY (rooms_id_fk, cards_id_fk));
            INSERT INTO room_members_new (rooms_id_fk,cards_id_fk,talkativeness)
                SELECT rm.rooms_id_fk, m.cards_id_fk, m.talkativeness
                FROM room_members rm JOIN members m ON m.members_id_pk=rm.members_id_fk;
            DROP TABLE room_members; ALTER TABLE room_members_new RENAME TO room_members;
            DROP TABLE members; COMMIT;`);
        db.exec('PRAGMA foreign_keys=ON');
    }
    // Room owner: the user whose persona sits in the room (lowest user id,
    // matching the convention generation uses for memory extraction).
    const rcolsEnd = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!rcolsEnd.includes('owner_users_id_fk')) db.exec('ALTER TABLE rooms ADD COLUMN owner_users_id_fk INTEGER');
    db.exec(`UPDATE rooms SET owner_users_id_fk=COALESCE((
        SELECT MIN(c.owner_users_id_fk) FROM room_members rm
        JOIN cards c ON c.cards_id_pk=rm.cards_id_fk
        WHERE rm.rooms_id_fk=rooms.rooms_id_pk AND c.is_persona=1),
        (SELECT users_id_pk FROM users ORDER BY users_id_pk LIMIT 1))
        WHERE owner_users_id_fk IS NULL`);
    const pprow = db.prepare('PRAGMA table_info(prompt_profiles)').all().map(c => c.name);
    if (!pprow.includes('include_time')) db.exec('ALTER TABLE prompt_profiles ADD COLUMN include_time INTEGER DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_logs (
        prompt_logs_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
        rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
        cards_id_fk INTEGER REFERENCES cards(cards_id_pk),
        kind TEXT NOT NULL DEFAULT 'reply',
        request TEXT NOT NULL,
        response TEXT DEFAULT '',
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        created TEXT DEFAULT (datetime('now')))`);
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

// Deterministic identicon avatar for a card — files land in data/cards and
// the column stores the api-facing path, same shape as an uploaded avatar.
function seedAvatar(cardId, name) {
    const file = `cards/${cardId}.png`;
    fs.mkdirSync(path.join(DATA_DIR, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, file), identiconPng(`${name}:${cardId}`));
    db.prepare('UPDATE cards SET avatar=? WHERE cards_id_pk=?').run(file, cardId);
}

export function seed() {
    // Test users — every account gets membership in room 1.
    const room = db.prepare('SELECT rooms_id_pk AS id FROM rooms ORDER BY rooms_id_pk LIMIT 1').get()?.id
        || db.prepare(`INSERT INTO rooms (name,mem_profiles_id_fk) VALUES ('The House',(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1))`).run().lastInsertRowid;
    for (const h of ['admin', 'alice', 'bob', 'carol']) {
        if (!db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get(h))
            createUser(h, 'changeme');
    }
    // Only auto-join the test users on a fresh install (no humans anywhere).
    const memberFor = (uid, handle) => {
        let pc = db.prepare('SELECT cards_id_pk FROM cards WHERE owner_users_id_fk=? AND is_persona=1').get(uid)?.cards_id_pk;
        if (!pc) {
            pc = db.prepare('INSERT INTO cards (owner_users_id_fk,name,is_persona) VALUES (?,?,1)').run(uid, handle).lastInsertRowid;
            seedAvatar(pc, handle);
        }
        return pc;
    };
    if (!db.prepare('SELECT 1 FROM room_members LIMIT 1').get()) {
        for (const h of ['admin', 'alice', 'bob', 'carol']) {
            const uid = db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get(h).id;
            db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)')
                .run(room, memberFor(uid, h));
        }
    }
    if (db.prepare('SELECT COUNT(*) c FROM messages').get().c) return;
    // Every room must follow a memory profile — ensure one exists and assign it.
    if (!db.prepare('SELECT 1 FROM mem_profiles LIMIT 1').get()) {
        const uid = db.prepare('SELECT users_id_pk AS id FROM users ORDER BY users_id_pk LIMIT 1').get()?.id;
        if (uid) db.prepare("INSERT INTO mem_profiles (users_id_fk,name,mem_unified) VALUES (?,'Default',1)").run(uid);
    }
    db.prepare('UPDATE rooms SET mem_profiles_id_fk=(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1) WHERE mem_profiles_id_fk IS NULL OR mem_profiles_id_fk=0').run();
    const mptest = db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get('mptest')?.id;
    if (mptest) db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,members_id_fk) VALUES (?,?)')
        .run(room, memberFor(mptest, 'mptest'));
    seedExamples(room);
    console.log('[db] users + room ensured');
}

// First-run example content: a demo character in the shared room, a small
// lorebook linked to it, a few memories in each scope, and a short welcome
// exchange — so a fresh install isn't a blank page. One-shot via a `meta`
// flag: pieces the user deletes are never resurrected. Skipped entirely on
// installs that already hold user-created cards or lorebooks, so upgrading
// an existing database doesn't get demo content injected.
function seedExamples(room) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    if (db.prepare('SELECT 1 FROM meta WHERE key=?').get('examples_seeded')) return;
    const flag = db.prepare('INSERT INTO meta (key,value) VALUES (?,?)');
    if (db.prepare('SELECT 1 FROM cards WHERE IFNULL(is_persona,0)=0 LIMIT 1').get()
        || db.prepare('SELECT 1 FROM world_books LIMIT 1').get()) {
        flag.run('examples_seeded', '0');
        return;
    }
    const uid = db.prepare('SELECT users_id_pk AS id FROM users ORDER BY users_id_pk LIMIT 1').get()?.id;
    if (!uid) { flag.run('examples_seeded', '0'); return; }

    const wren = db.prepare(`INSERT INTO cards (owner_users_id_fk,name,description,personality,scenario,first_message,mes_example,tags,creator)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(uid, 'Wren',
        "Wren is the caretaker of The House — a quiet, attentive figure who keeps the place running. She appears when she's needed: refills the kettle, fixes the draughty window, leaves notes on the kitchen board. She speaks plainly, with dry warmth, and knows every creak in the floorboards.",
        "Calm, observant, dry humour. Helpful without fussing. Notices the small things about people and remembers them.",
        "The House is a shared living space where its residents come and go. Wren keeps it — nobody remembers hiring her, but the plants are always watered.",
        "The kettle had just boiled when you walked in. Wren set down a second cup without being asked. \"You look like you've had a day. Sit — the armchair by the window's the good one.\"",
        "<START>\n{{user}}: Do you ever sleep, Wren?\n{{char}}: \"The House sleeps. I keep it.\" She folds a tea towel with surgical precision. \"But if it makes you feel better, I'll close my eyes on Tuesdays.\"\n<START>\n{{user}}: What's behind the locked door upstairs?\n{{char}}: \"Storage.\" A pause that lands exactly one beat too long. \"And the previous caretaker's dignity.\"",
        '["demo"]', 'seed').lastInsertRowid;
    seedAvatar(wren, 'wren');
    db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)').run(room, wren);

    const book = db.prepare('INSERT INTO world_books (owner_users_id_fk,name) VALUES (?,?)')
        .run(uid, 'The House — notes').lastInsertRowid;
    const ins = db.prepare('INSERT INTO world_entries (comment,content,constant,enabled,ord) VALUES (?,?,?,?,?)');
    const link = db.prepare('INSERT INTO book_entries (world_books_id_fk,world_entries_id_fk) VALUES (?,?)');
    const ik = db.prepare('INSERT OR IGNORE INTO world_entry_keys (world_entries_id_fk,word,kind) VALUES (?,?,?)');
    for (const e of [
        { comment: 'Wren (always in context)', content: "Wren has been the caretaker of The House for as long as anyone can remember.", constant: 1, keys: [] },
        { comment: 'About The House', content: "The House is a three-storey Edwardian terrace that somehow always has enough rooms. It creaks, it leaks heat, and it is loved.", keys: ['house'] },
        { comment: 'The kitchen', content: "The kitchen is the heart of The House — a long wooden table, a kettle that never quite stops steaming, and a pinboard of notes and bills.", keys: ['kitchen', 'kettle', 'tea'] },
        { comment: 'The garden', content: "Out back is a walled garden gone slightly feral — lavender, a leaning apple tree, and a greenhouse where Wren keeps seedlings.", keys: ['garden', 'greenhouse', 'apple'] },
    ]) {
        const eid = ins.run(e.comment, e.content, e.constant ? 1 : 0, 1, 0).lastInsertRowid;
        for (const w of e.keys) ik.run(eid, w, 'primary');
        link.run(book, eid);
    }
    db.prepare('INSERT INTO room_books (rooms_id_fk,world_books_id_fk) VALUES (?,?)').run(room, book);

    const mem = (content, type, origin, triggers, cardId) => {
        const id = db.prepare('INSERT INTO memories (content,type,origin,triggers) VALUES (?,?,?,?)')
            .run(content, type, origin, triggers).lastInsertRowid;
        db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(room, id);
        if (cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, cardId);
    };
    mem('The House has a leaning apple tree in the back garden.', 'fact', 'user', 'garden, apple', 0);
    mem('Residents take their tea strong — Wren keeps biscuits in the blue tin.', 'preference', 'user', 'tea, biscuits', 0);
    mem('Wren once fixed the upstairs window during a storm without being asked.', 'event', 'user', 'window, storm', wren);
    mem('Wren considers everyone under the roof hers to look after.', 'relationship', 'smart', 'wren, caretaker', 0);

    const imsg = db.prepare('INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,?,?)');
    imsg.run(room, null, 'Welcome to BOLLOCKS — this is a seeded example chat. Set up an API connection on the Connection page, then say something and Wren will answer.');
    imsg.run(room, wren, "The kettle had just boiled when you walked in. Wren set down a second cup without being asked. \"You look like you've had a day. Sit — the armchair by the window's the good one.\"");

    flag.run('examples_seeded', '1');
    console.log('[db] seeded example content (Wren, lorebook, memories)');
}
