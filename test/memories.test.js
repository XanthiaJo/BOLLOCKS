// Memories: room- and card-scoped create/read, update, trigger editing,
// card↔room moves, delete, and the lastmem shortcut.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('memories', () => {
    test('create/update/move/delete across room and card scope', async () => {
        const room = (await s.post('rooms', { name: 'Mem room' })).json.id;
        const card = (await s.post('cards', { name: 'MemBot' })).json.id;

        const roomMem = (await s.post('memories', { room, content: 'Room fact', type: 'fact', triggers: 'door' })).json.id;
        const cardMem = (await s.post('memories', { room, cardId: card, content: 'Card pref', type: 'preference' })).json.id;

        // card=-1 returns everything for the room; card=N scopes to that card.
        const all = (await s.get(`memories?card=-1&room=${room}`)).json.memories;
        assert.equal(all.length, 2);
        const scoped = (await s.get(`memories?card=${card}&room=${room}`)).json.memories;
        assert.deepEqual(scoped.map(m => m.id), [cardMem]);
        assert.equal(scoped[0].card_name, 'MemBot');

        assert.equal((await s.post('memories/update', { id: roomMem, content: 'Updated', origin: 'smart' })).status, 200);
        assert.equal((await s.post('memories/triggers', { id: roomMem, triggers: 'window' })).status, 200);
        const updated = (await s.get(`memories?card=-1&room=${room}`)).json.memories.find(m => m.id === roomMem);
        assert.equal(updated.content, 'Updated');
        assert.equal(updated.origin, 'smart');
        assert.equal(updated.triggers, 'window');
        assert.equal((await s.get(`lastmem?room=${room}`)).json.text, 'Updated'); // latest smart memory

        // Move card-scoped memory back to room scope.
        assert.equal((await s.post('memories/move', { id: cardMem, cardId: null })).status, 200);
        assert.equal((await s.get(`memories?card=${card}&room=${room}`)).json.memories.length, 0);

        assert.equal((await s.post('memories/delete', { id: cardMem })).status, 200);
        assert.equal((await s.get(`memories?card=-1&room=${room}`)).json.memories.length, 1);
        await s.post('rooms/delete', { id: room });
        await s.post('cards/delete', { id: card });
    });
});

// Older builds re-add a `source` column to a migrated memories table (their
// migrateSchema ALTERs it back when missing), leaving both source and origin.
// The rebuild must keep an existing origin='smart' instead of re-deriving
// everything from source — otherwise every smart row flattens to 'user'.
test('memories rebuild preserves origin when source column is also present', async () => {
    const dir = tmp('data');
    fs.mkdirSync(path.join(dir), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'app.db'));
    db.exec(`CREATE TABLE memories (memories_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL, created TEXT DEFAULT (datetime('now')),
        type TEXT DEFAULT 'fact', origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','smart')),
        triggers TEXT DEFAULT '', source TEXT DEFAULT 'manual')`);
    db.prepare("INSERT INTO memories (content,origin,source) VALUES ('smart fact','smart','manual'),('perm fact','user','manual'),('old auto','user','auto')").run();
    db.close();

    const srv = await boot(dir);
    try {
        const check = new DatabaseSync(path.join(dir, 'app.db'));
        const rows = check.prepare('SELECT content,origin FROM memories').all();
        check.close();
        const by = Object.fromEntries(rows.map(r => [r.content, r.origin]));
        assert.equal(by['smart fact'], 'smart');
        assert.equal(by['perm fact'], 'user');
        assert.equal(by['old auto'], 'smart');
    } finally {
        await srv.stop();
    }
});
