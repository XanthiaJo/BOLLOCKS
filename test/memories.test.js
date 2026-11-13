// Memories: room- and card-scoped create/read, update, trigger editing,
// card↔room moves, delete, and the lastmem shortcut.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('creamms'); });
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
