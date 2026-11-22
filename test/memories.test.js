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

        // Clearing trigger keywords promotes a memory to canon (always injected).
        assert.equal((await s.post('memories/update', { id: roomMem, triggers: '' })).status, 200);
        assert.equal((await s.get(`memories?card=-1&room=${room}`)).json.memories.find(m => m.id === roomMem).triggers, null);

        // Move card-scoped memory back to room scope.
        assert.equal((await s.post('memories/move', { id: cardMem, cardId: null })).status, 200);
        assert.equal((await s.get(`memories?card=${card}&room=${room}`)).json.memories.length, 0);

        assert.equal((await s.post('memories/delete', { id: cardMem })).status, 200);
        assert.equal((await s.get(`memories?card=-1&room=${room}`)).json.memories.length, 1);
        await s.post('rooms/delete', { id: room });
        await s.post('cards/delete', { id: card });
    });

    test('dedupe retires retold smart events under the newer telling', async () => {
        const room = (await s.post('rooms', { name: 'Dedupe room' })).json.id;
        const seed = async (content, triggers) => {
            const id = (await s.post('memories', { room, content, type: 'event', triggers })).json.id;
            await s.post('memories/update', { id, origin: 'smart' });
            return id;
        };
        // Two tellings of one event share their rare trigger words; a
        // distinct event and a user-authored row must stay untouched.
        const oldTelling = await seed('A flapjack vanished from the bed overnight, leaving crumbs.', 'flapjack,crumbs,buddy,mystery');
        const newTelling = await seed('Rackington named Blake the flapjack culprit after clearing Buddy.', 'flapjack,crumbs,blake,culprit');
        const distinct = await seed('Buddy claimed the pillow by sitting on it.', 'pillow,claim');
        const userMem = (await s.post('memories', { room, content: 'Karima baked the flapjack.', type: 'event', triggers: 'flapjack,crumbs' })).json.id;

        const merged = (await s.post('memories/dedupe', { room })).json.merged;
        assert.deepEqual(merged, [[oldTelling, newTelling]]);

        const mems = (await s.get(`memories?card=-1&room=${room}`)).json.memories;
        assert.equal(mems.find(m => m.id === oldTelling).superseded_by_memories_id_fk, newTelling);
        assert.equal(mems.find(m => m.id === distinct).superseded_by_memories_id_fk, null);
        assert.equal(mems.find(m => m.id === userMem).superseded_by_memories_id_fk, null);
        await s.post('rooms/delete', { id: room });
    });

    test('link merges chains by created date regardless of drop direction', async () => {
        const room = (await s.post('rooms', { name: 'Link room' })).json.id;
        const seed = async content => (await s.post('memories', { room, content, type: 'event', triggers: 'x' })).json.id;
        const sup = async id => (await s.get(`memories?card=-1&room=${room}`)).json.memories.find(m => m.id === id).superseded_by_memories_id_fk;

        const older = await seed('Buddy napped on the bed.');
        await new Promise(r => setTimeout(r, 1100)); // created is second-resolution
        const newer = await seed('Buddy moved to the bowl.');

        // Dragging the newer onto the older still leaves the newer live —
        // `created` resolves order, not drop direction.
        assert.equal((await s.post('memories/link', { id: newer, target: older })).status, 200);
        assert.equal(await sup(older), newer);
        assert.equal(await sup(newer), null);

        // Merging chains: a head with a draft behind it re-points whole.
        await new Promise(r => setTimeout(r, 1100));
        const third = await seed('Buddy finally settled in the doorway.');
        await s.post('memories/link', { id: newer, target: third });
        assert.equal(await sup(newer), third);   // old head → new head
        assert.equal(await sup(older), newer);   // draft keeps its own pointer
        // Linking a superseded row re-resolves through its head — same
        // chain now, so it's a no-op rather than a duplicate pointer.
        assert.equal((await s.post('memories/link', { id: older, target: third })).status, 200);
        assert.equal(await sup(older), newer);

        // Dropping a card on itself is a no-op, not a tombstone.
        const lone = await seed('Karima made fudge.');
        assert.equal((await s.post('memories/link', { id: lone, target: lone })).status, 200);
        assert.equal(await sup(lone), null);

        // Drag-out: unlink detaches a superseded row back to live, and
        // its draft keeps pointing at it (the head it built stays put).
        assert.equal((await s.post('memories/unlink', { id: older })).status, 200);
        assert.equal(await sup(older), null);
        assert.equal(await sup(newer), third); // old chain unaffected
        // Unlink with a target re-points the row under that chain's head.
        assert.equal((await s.post('memories/unlink', { id: older, target: newer })).status, 200);
        assert.equal(await sup(older), third); // newer's head is third
        // Unlinking a live row is a no-op.
        assert.equal((await s.post('memories/unlink', { id: lone })).status, 200);
        assert.equal(await sup(lone), null);
        await s.post('rooms/delete', { id: room });
    });

    test('user-sorted rows are invisible to the dedupe sweep', async () => {
        const room = (await s.post('rooms', { name: 'Curated room' })).json.id;
        const seed = async content => {
            const id = (await s.post('memories', { room, content, type: 'event', triggers: 'fudge,rivalry' })).json.id;
            await s.post('memories/update', { id, origin: 'smart' });
            return id;
        };
        const sup = async id => (await s.get(`memories?card=-1&room=${room}`)).json.memories.find(m => m.id === id);
        // Identical trigger vocab — every pair here would chain in a sweep.
        const x1 = await seed('Buddy won the fudge.');
        const x2 = await seed('Buddy claimed the fudge again.');
        const y1 = await seed('Buddy scored the fudge.');
        const y2 = await seed('Buddy took the fudge once more.');
        // Hand-arrange the y pair: link then pull y1 back out — both stay
        // flagged as user-sorted, which must immunise them from the sweep.
        await s.post('memories/link', { id: y1, target: y2 });
        await s.post('memories/unlink', { id: y1 });
        assert.equal((await sup(y1)).user_sorted, 1);
        const merged = (await s.post('memories/dedupe', { room })).json.merged;
        assert.deepEqual(merged, [[x1, x2]]);
        assert.equal((await sup(y1)).superseded_by_memories_id_fk, null);
        assert.equal((await sup(y2)).superseded_by_memories_id_fk, null);
        await s.post('rooms/delete', { id: room });
    });
});

// Older builds re-add a `source` column to a migrated memories table (their
// migrateSchema ALTERs it back when missing), leaving both source and origin.
// The rebuild must keep an existing origin='smart' instead of re-deriving
// everything from source — otherwise every smart row flattens to 'user'.
test('fresh DB boots with the canonical schema', async () => {
    const dir = tmp('data');
    fs.mkdirSync(dir, { recursive: true });
    const srv = await boot(dir);
    try {
        const check = new DatabaseSync(path.join(dir, 'app.db'));
        const cols = t => check.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
        const mem = cols('memories');
        for (const c of ['room_arcs_id_fk', 'state_key', 'superseded_by_memories_id_fk',
            'last_fired_messages_id_fk', 'last_fired_at', 'user_sorted'])
            assert.ok(mem.includes(c), `memories.${c}`);
        const mp = cols('mem_profiles');
        for (const c of ['mem_prune_messages', 'mem_readonly', 'extraction_api_profiles_id_fk',
            'arc_api_profiles_id_fk', 'mem_state', 'mem_state_prompt'])
            assert.ok(mp.includes(c), `mem_profiles.${c}`);
        for (const legacy of ['auto_mem', 'mem_extraction_profile_id', 'mem_arc_profile_id'])
            assert.ok(!mp.includes(legacy), `mem_profiles.${legacy} dropped`);
        const rooms = cols('rooms');
        for (const c of ['mem_profiles_id_fk', 'mem_last_messages_id_fk', 'mem_extract_count',
            'mem_refresh_count', 'owner_users_id_fk'])
            assert.ok(rooms.includes(c), `rooms.${c}`);
        assert.ok(!rooms.includes('mem_last_messages_id'), 'legacy pointer dropped');
        const msgs = cols('messages');
        assert.ok(msgs.includes('supersedes_messages_id_fk'));
        for (const t of ['room_arcs', 'memory_triggers', 'prompt_logs', 'prompt_profiles'])
            assert.ok(check.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t), t);
        assert.equal(check.prepare('PRAGMA user_version').get().user_version, 8);
        check.close();
    } finally {
        await srv.stop();
    }
});
