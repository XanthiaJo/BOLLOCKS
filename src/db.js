import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { identiconPng } from './lib/identicon.js';

export const DATA_DIR = path.resolve(process.env.BOLLOCKS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
// Declared REFERENCES clauses are enforced — they're the safety net behind
// the route-ordered delete cascades (see lib/cascade.js).
db.exec('PRAGMA foreign_keys=ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    users_id_pk INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    settings TEXT DEFAULT '{}', email TEXT DEFAULT '', admin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    sessions_token_pk TEXT PRIMARY KEY,
    users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
    rooms_id_pk INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    ai_trigger TEXT DEFAULT 'manual',
    bg TEXT DEFAULT '',
    mem_last_messages_id_fk INTEGER DEFAULT 0, -- stale-tolerant pointer; deliberately no REFERENCES
    mem_refresh_count INTEGER DEFAULT 0,
    mem_extract_count INTEGER DEFAULT 0,
    mem_profiles_id_fk INTEGER REFERENCES mem_profiles(mem_profiles_id_pk) ON DELETE SET NULL,
    max_context INTEGER DEFAULT 0,
    owner_users_id_fk INTEGER REFERENCES users(users_id_pk)
);
CREATE TABLE IF NOT EXISTS room_members (
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
    talkativeness INTEGER DEFAULT 50,
    PRIMARY KEY (rooms_id_fk, cards_id_fk)
);
CREATE TABLE IF NOT EXISTS cards (
    cards_id_pk INTEGER PRIMARY KEY,
    owner_users_id_fk INTEGER REFERENCES users(users_id_pk),
    name TEXT NOT NULL, description TEXT DEFAULT '',
    first_message TEXT DEFAULT '',
    personality TEXT DEFAULT '', scenario TEXT DEFAULT '', mes_example TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '', post_history_instructions TEXT DEFAULT '',
    alternate_greetings TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', creator TEXT DEFAULT '',
    creatorcomment TEXT DEFAULT '', character_version TEXT DEFAULT '', avatar TEXT DEFAULT '',
    card_json TEXT DEFAULT '', is_persona INTEGER DEFAULT 0,
    api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk)
);
CREATE TABLE IF NOT EXISTS messages (
    messages_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    cards_id_fk INTEGER REFERENCES cards(cards_id_pk),
    text TEXT NOT NULL,
    send_date TEXT DEFAULT (datetime('now')),
    supersedes_messages_id_fk INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(rooms_id_fk, messages_id_pk);
CREATE TABLE IF NOT EXISTS world_books (
    world_books_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_users_id_fk INTEGER REFERENCES users(users_id_pk),
    name TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS book_entries (
    world_books_id_fk INTEGER NOT NULL REFERENCES world_books(world_books_id_pk),
    world_entries_id_fk INTEGER NOT NULL REFERENCES world_entries(world_entries_id_pk),
    UNIQUE(world_books_id_fk, world_entries_id_fk)
);
CREATE TABLE IF NOT EXISTS world_entries (
    world_entries_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT DEFAULT '',
    constant INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    ord INTEGER DEFAULT 0,
    comment TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS world_entry_keys (
    world_entries_id_fk INTEGER NOT NULL REFERENCES world_entries(world_entries_id_pk),
    word TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'primary' CHECK(kind IN ('primary','secondary')),
    UNIQUE(world_entries_id_fk, word, kind)
);
CREATE TABLE IF NOT EXISTS room_books (
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    world_books_id_fk INTEGER NOT NULL REFERENCES world_books(world_books_id_pk),
    UNIQUE(rooms_id_fk, world_books_id_fk)
);
CREATE TABLE IF NOT EXISTS memories (
    memories_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created TEXT DEFAULT (datetime('now')),
    type TEXT DEFAULT 'fact',
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','smart')),
    room_arcs_id_fk INTEGER REFERENCES room_arcs(room_arcs_id_pk) ON DELETE SET NULL,
    state_key TEXT,
    superseded_by_memories_id_fk INTEGER REFERENCES memories(memories_id_pk) ON DELETE SET NULL,
    last_fired_messages_id_fk INTEGER,
    last_fired_at TEXT,
    user_sorted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_triggers (
    memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
    word TEXT NOT NULL,
    PRIMARY KEY (memories_id_fk, word)
);
CREATE TABLE IF NOT EXISTS memory_cards (
    memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
    cards_id_fk INTEGER NOT NULL REFERENCES cards(cards_id_pk),
    PRIMARY KEY (memories_id_fk, cards_id_fk)
);
CREATE TABLE IF NOT EXISTS room_memories (
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
    PRIMARY KEY (rooms_id_fk, memories_id_fk)
);
CREATE TABLE IF NOT EXISTS room_arcs (
    room_arcs_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    title TEXT NOT NULL,
    summary TEXT DEFAULT '',
    status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','dropped')),
    origin TEXT DEFAULT 'user' CHECK(origin IN ('user','smart')),
    opened_messages_id_fk INTEGER REFERENCES messages(messages_id_pk) ON DELETE SET NULL,
    closed_messages_id_fk INTEGER REFERENCES messages(messages_id_pk) ON DELETE SET NULL,
    created TEXT DEFAULT (datetime('now')),
    updated TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_profiles (
    api_profiles_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
    name TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL DEFAULT '',
    active INTEGER DEFAULT 0,
    strip_prefix INTEGER DEFAULT 1,
    headers TEXT DEFAULT '{}',
    context_size INTEGER DEFAULT 0,
    max_response INTEGER DEFAULT 2048
);
CREATE TABLE IF NOT EXISTS mem_profiles (
    mem_profiles_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
    name TEXT NOT NULL,
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
    extraction_api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk) ON DELETE SET NULL,
    mem_canon_budget INTEGER DEFAULT 800,
    mem_max_arcs INTEGER DEFAULT 10,
    mem_arc_budget INTEGER DEFAULT 700,
    arc_api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk) ON DELETE SET NULL,
    mem_state INTEGER DEFAULT 0,
    mem_state_every INTEGER DEFAULT 1,
    mem_max_state INTEGER DEFAULT 30,
    mem_state_budget INTEGER DEFAULT 400,
    mem_state_prompt TEXT DEFAULT '',
    mem_readonly INTEGER DEFAULT 0,
    mem_prune_messages INTEGER DEFAULT 0,
    mem_sweep INTEGER DEFAULT 0,
    mem_sweep_every INTEGER DEFAULT 5,
    sweep_api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS prompt_profiles (
    prompt_profiles_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    users_id_fk INTEGER NOT NULL REFERENCES users(users_id_pk),
    name TEXT NOT NULL,
    prompt_order TEXT,
    active INTEGER DEFAULT 0,
    include_time INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prompt_logs (
    prompt_logs_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms_id_fk INTEGER NOT NULL REFERENCES rooms(rooms_id_pk),
    cards_id_fk INTEGER REFERENCES cards(cards_id_pk),
    kind TEXT NOT NULL DEFAULT 'reply',
    request TEXT NOT NULL,
    response TEXT DEFAULT '',
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created TEXT DEFAULT (datetime('now'))
);
`);


export const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
    ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
export const verify = (pw, salt, h) =>
    crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(h, 'hex'));

export function createUser(handle, password) {
    const { salt, hash: h } = hash(password);
    const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    const id = db.prepare('INSERT INTO users (handle,password_hash,salt,admin) VALUES (?,?,?,?)')
        .run(handle, h, salt, first ? 1 : 0).lastInsertRowid;
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


/** Schema touch-ups for existing DBs (the CREATE TABLE block is the
 *  baseline for fresh installs — historical migrations were retired at
 *  user_version 8). Add new migrations here as guarded ALTERs:
 *    const colsOf = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
 *    if (!colsOf('t').includes('c')) db.exec('ALTER TABLE t ADD COLUMN c ...');
 *  One-time data fixes gate on PRAGMA user_version bumps. */
export function migrateSchema() {
    const colsOf = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    // Columns added after the v0.2.0 live build — DBs still at that shape
    // need them before code touches them.
    const mcols = colsOf('memories');
    if (!mcols.includes('last_fired_messages_id_fk'))
        db.exec('ALTER TABLE memories ADD COLUMN last_fired_messages_id_fk INTEGER');
    if (!mcols.includes('last_fired_at'))
        db.exec('ALTER TABLE memories ADD COLUMN last_fired_at TEXT');
    if (!mcols.includes('user_sorted'))
        db.exec('ALTER TABLE memories ADD COLUMN user_sorted INTEGER DEFAULT 0');
    if (!colsOf('mem_profiles').includes('mem_prune_messages'))
        db.exec('ALTER TABLE mem_profiles ADD COLUMN mem_prune_messages INTEGER DEFAULT 0');
    if (!colsOf('mem_profiles').includes('mem_sweep'))
        db.exec('ALTER TABLE mem_profiles ADD COLUMN mem_sweep INTEGER DEFAULT 0');
    if (!colsOf('mem_profiles').includes('mem_sweep_every'))
        db.exec('ALTER TABLE mem_profiles ADD COLUMN mem_sweep_every INTEGER DEFAULT 5');
    if (!colsOf('mem_profiles').includes('sweep_api_profiles_id_fk'))
        db.exec('ALTER TABLE mem_profiles ADD COLUMN sweep_api_profiles_id_fk INTEGER REFERENCES api_profiles(api_profiles_id_pk)');
    if (Number(db.prepare('PRAGMA user_version').get().user_version) < 8)
        db.exec('PRAGMA user_version=8');
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
    // The seeded room needs an owner or nobody can touch its settings.
    db.prepare('UPDATE rooms SET owner_users_id_fk=(SELECT users_id_pk FROM users ORDER BY users_id_pk LIMIT 1) WHERE owner_users_id_fk IS NULL').run();
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
        if (uid) db.prepare("INSERT INTO mem_profiles (users_id_fk,name,mem_unified,mem_prune_messages) VALUES (?,'Default',1,50)").run(uid);
    }
    db.prepare('UPDATE rooms SET mem_profiles_id_fk=(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1) WHERE mem_profiles_id_fk IS NULL OR mem_profiles_id_fk=0').run();
    const mptest = db.prepare('SELECT users_id_pk AS id FROM users WHERE handle=?').get('mptest')?.id;
    if (mptest) db.prepare('INSERT OR IGNORE INTO room_members (rooms_id_fk,cards_id_fk) VALUES (?,?)')
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
        .run(uid, 'The House').lastInsertRowid;
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
        const id = db.prepare('INSERT INTO memories (content,type,origin) VALUES (?,?,?)')
            .run(content, type, origin).lastInsertRowid;
        const insTrig = db.prepare('INSERT OR IGNORE INTO memory_triggers (memories_id_fk,word) VALUES (?,?)');
        for (const w of (triggers || '').split(',')) { const word = w.trim().toLowerCase(); if (word) insTrig.run(id, word); }
        db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(room, id);
        if (cardId) db.prepare('INSERT INTO memory_cards (memories_id_fk,cards_id_fk) VALUES (?,?)').run(id, cardId);
        return id;
    };
    mem('The House has a leaning apple tree in the back garden.', 'fact', 'user', 'garden, apple', 0);
    mem('Residents take their tea strong — Wren keeps biscuits in the blue tin.', 'preference', 'user', 'tea, biscuits', 0);
    mem('Wren once fixed the upstairs window during a storm without being asked.', 'event', 'user', 'window, storm', wren);
    mem('Wren considers everyone under the roof hers to look after.', 'relationship', 'smart', 'wren, caretaker', 0);

    // Consolidation sample: the same beat retold three ways with fully
    // paraphrased trigger vocab (the case the lexical scorer can't catch).
    // The two older tellings sit superseded under the newest — `history ▸`
    // on the card shows the chain a dedupe sweep or drag-link would make.
    const mTin1 = mem('Wren set the blue tin back on the counter after tea.', 'event', 'smart', 'wren, tin, counter', 0);
    const mTin2 = mem('She moved it again — tin went from counter to windowsill.', 'event', 'smart', 'moved, windowsill', 0);
    const mTin3 = mem('The tin ended up on the sill by the end of the evening.', 'event', 'smart', 'sill, evening', 0);
    db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?').run(mTin2, mTin1);
    db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?').run(mTin3, mTin2);
    // A pruned dead-end: retired with no successor (self-tombstone) — shows
    // in the Retracted accordion as cap/dormancy output rather than merge.
    db.prepare('UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk WHERE memories_id_pk=?')
        .run(mem('Someone left a muddy boot by the back door.', 'event', 'smart', 'boot, mud', 0));
    // Fired-watermark variety for the cards' `fired …` / `never fired` meta.
    db.prepare("UPDATE memories SET last_fired_messages_id_fk=1, last_fired_at=datetime('now') WHERE memories_id_pk=?")
        .run(mTin3);

    // Scene-state sample — subject→state rows keyed exactly like the state
    // pass writes them (state_key is the diff handle).
    const insTrig = db.prepare('INSERT OR IGNORE INTO memory_triggers (memories_id_fk,word) VALUES (?,?)');
    const state = (key, val) => {
        const id = db.prepare("INSERT INTO memories (content,type,origin,state_key) VALUES (?, 'state', 'smart', ?)")
            .run(`${key} — ${val}`, key).lastInsertRowid;
        db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(room, id);
        return id;
    };
    state('Wren', 'in the kitchen, refilling the kettle');
    state('the blue tin', 'on the counter, half full');
    // History samples: the window's earlier state sits superseded under the
    // current row (the chain the diff would have written); 'the storm' is a
    // retracted tombstone (superseded_by self — dropped, no successor).
    const winOld = state('the upstairs window', 'cracked open, draughty');
    const winNew = state('the upstairs window', 'repaired, no longer draughty');
    db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?').run(winNew, winOld);
    db.prepare('UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk WHERE memories_id_pk=?')
        .run(state('the storm', 'rattling the shutters'));
    state('the locked door', 'still locked');

    // Story threads: one open manual arc, one resolved smart arc with a
    // folded detail memory — it stays quiet until its trigger re-evokes the
    // chapter under "Earlier events:".
    const iarc = db.prepare("INSERT INTO room_arcs (rooms_id_fk,title,summary,status,origin) VALUES (?,?,?,?,?)");
    iarc.run(room, 'The greenhouse pane', 'A pane cracked in the last storm; taped for now but needs replacing before frost.', 'open', 'user');
    const closedArc = iarc.run(room, 'The missing biscuit tin', 'The blue tin vanished for a day — found under the settle behind a stack of blankets.', 'resolved', 'smart').lastInsertRowid;
    const folded = db.prepare("INSERT INTO memories (content,type,origin,room_arcs_id_fk) VALUES (?, 'event', 'smart', ?)")
        .run('The blue tin was found under the settle, biscuits intact.', closedArc).lastInsertRowid;
    insTrig.run(folded, 'tin');
    db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)').run(room, folded);

    const imsg = db.prepare('INSERT INTO messages (rooms_id_fk,cards_id_fk,text) VALUES (?,?,?)');
    imsg.run(room, null, 'Welcome to BOLLOCKS — this is a seeded example chat. Set up an API connection on the Connection page, then say something and Wren will answer.');
    imsg.run(room, wren, "The kettle had just boiled when you walked in. Wren set down a second cup without being asked. \"You look like you've had a day. Sit — the armchair by the window's the good one.\"");

    flag.run('examples_seeded', '1');
    console.log('[db] seeded example content (Wren, lorebook, memories)');
}
