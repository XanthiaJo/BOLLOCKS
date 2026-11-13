// Cross-user access control: a user outside a room or book gets nothing —
// no reads, no writes, no listening, no admin actions.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, asUser } from './helpers.js';

let s;
const asKarima = fn => asUser(s, 'alice')(fn);
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('access control', () => {
    // A private room alice is NOT in, with data inside it.
    let priv, privMem, privMsg, privBook, privEntry;

    before(async () => {
        priv = (await s.post('rooms', { name: 'Private' })).json.id;
        privMsg = (await s.post('say', { room: priv, text: 'secret' })).json.id;
        privMem = (await s.post('memories', { room: priv, content: 'secret lore' })).json.id;
        privBook = (await s.post('world/books', { name: 'PrivateBook' })).json.id;
        privEntry = (await s.post('world', { book: privBook, content: 'hidden' })).json.id;
    });
    after(async () => {
        await s.post('rooms/delete', { id: priv });
        await s.post('world/books/delete', { id: privBook });
    });

    test('non-members cannot read, post, or listen into another room', async () => {
        await asKarima(async () => {
            assert.equal((await s.get(`room?id=${priv}`)).status, 403);
            assert.equal((await s.get(`lastmem?room=${priv}`)).status, 403);
            assert.equal((await s.get(`genstats?room=${priv}`)).status, 403);
            assert.equal((await s.get(`memories?card=-1&room=${priv}`)).status, 403);
            assert.equal((await s.get(`stream?room=${priv}`)).status, 403);
            assert.equal((await s.post('say', { room: priv, text: 'sneak' })).status, 403);
            assert.equal((await s.post('generate', { room: priv })).status, 403);
            assert.equal((await s.post('memories', { room: priv, content: 'x' })).status, 403);
            assert.equal((await s.post('messages/delete', { id: privMsg })).status, 403);
        });
        assert.ok((await s.get(`room?id=${priv}`)).json.messages.some(m => m.id === privMsg));
    });

    test('non-members cannot edit memories in rooms they are not in', async () => {
        await asKarima(async () => {
            for (const [route, body] of [
                ['memories/update', { id: privMem, content: 'hax' }],
                ['memories/triggers', { id: privMem, triggers: 'x' }],
                ['memories/move', { id: privMem, cardId: null }],
                ['memories/delete', { id: privMem }],
            ]) assert.equal((await s.post(route, body)).status, 403, route);
        });
        assert.equal((await s.get(`memories?card=-1&room=${priv}`)).json.memories[0].content, 'secret lore');
    });

    test('users cannot write into books they do not own', async () => {
        await asKarima(async () => {
            assert.equal((await s.post('world', { book: privBook, content: 'graffiti' })).status, 403);
            assert.equal((await s.post('world/update', { id: privEntry, content: 'graffiti' })).status, 403);
            assert.equal((await s.post('world/delete', { id: privEntry })).status, 403);
        });
        assert.equal((await s.get(`world?book=${privBook}`)).json.entries[0].content, 'hidden');
    });

    test('user administration is admin-only', async () => {
        await asKarima(async () => {
            const bob = (await s.get('users')).json.users.find(u => u.handle === 'bob');
            assert.equal((await s.post('users/delete', { id: bob.id })).status, 403);
            assert.equal((await s.post('register', { handle: 'sneaky', password: 'pw' })).status, 403);
        });
        assert.ok((await s.get('users')).json.users.some(u => u.handle === 'bob'));
    });
});
