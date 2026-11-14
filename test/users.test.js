// User administration: listing and delete rules (cross-user delete is
// covered under admin checks in access.test.js).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('users', () => {
    test('list shows seeded users; deleting self or unknown is refused', async () => {
        const users = (await s.get('users')).json.users;
        assert.deepEqual(users.map(u => u.handle), ['admin', 'alice', 'bob', 'carol']);
        const me = users.find(u => u.handle === 'admin');
        assert.equal((await s.post('users/delete', { id: me.id })).status, 400);
        assert.equal((await s.post('users/delete', { handle: 'ghost' })).status, 400);
    });

    test('deleting a user cascades their content', async () => {
        // carol has a seeded persona card seated in The House — previously
        // the delete 500ed on FOREIGN KEY constraints (cards, profiles…).
        const carol = (await s.get('users')).json.users.find(u => u.handle === 'carol');
        assert.ok(carol);
        assert.equal((await s.post('users/delete', { id: carol.id })).status, 200);
        const users = (await s.get('users')).json.users;
        assert.ok(!users.some(u => u.handle === 'carol'));
        const members = (await s.get('room?id=1')).json.members;
        assert.ok(!members.some(m => m.handle === 'carol'));
    });
});
