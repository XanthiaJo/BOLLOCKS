// User administration: listing and delete rules (cross-user delete is
// covered under admin checks in access.test.js).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('creamms'); });
after(() => s.stop());

describe('users', () => {
    test('list shows seeded users; deleting self or unknown is refused', async () => {
        const users = (await s.get('users')).json.users;
        assert.deepEqual(users.map(u => u.handle), ['creamms', 'karima', 'blake', 'entropy75']);
        const me = users.find(u => u.handle === 'creamms');
        assert.equal((await s.post('users/delete', { id: me.id })).status, 400);
        assert.equal((await s.post('users/delete', { handle: 'ghost' })).status, 400);
    });
});
