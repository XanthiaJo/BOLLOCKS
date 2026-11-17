// User administration: listing and delete rules (cross-user delete is
// covered under admin checks in access.test.js).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, asUser } from './helpers.js';

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

    test('admin user list exposes handle, email, persona and the admin flag', async () => {
        const r = await s.get('admin/users');
        assert.equal(r.status, 200);
        const admin = r.json.users.find(u => u.handle === 'admin');
        assert.ok(admin.admin);
        assert.ok('email' in admin && 'persona_name' in admin && 'id' in admin);
        assert.deepEqual(r.json.users.map(u => u.handle), ['admin', 'alice', 'bob']);
    });

    test('non-admins get 403 on every admin user route', async () => {
        const alice = (await s.get('users')).json.users.find(u => u.handle === 'alice');
        await asUser(s, 'alice')(async () => {
            assert.equal((await s.get('admin/users')).status, 403);
            assert.equal((await s.post('admin/users/update', { id: alice.id, handle: 'x' })).status, 403);
            assert.equal((await s.post('admin/users/password', { id: alice.id, password: 'x' })).status, 403);
        });
    });

    test('admin update renames a user and sets email; conflicts are refused', async () => {
        const bob = (await s.get('users')).json.users.find(u => u.handle === 'bob');
        assert.equal((await s.post('admin/users/update', { id: bob.id, handle: 'bobby', email: 'b@x.test' })).status, 200);
        const u = (await s.get('admin/users')).json.users.find(x => x.id === bob.id);
        assert.equal(u.handle, 'bobby');
        assert.equal(u.email, 'b@x.test');
        assert.equal((await s.post('admin/users/update', { id: bob.id, handle: 'ALICE' })).status, 409);
        await s.post('admin/users/update', { id: bob.id, handle: 'bob' });
    });

    test('admin password reset rotates credentials and kills old sessions', async () => {
        const bob = (await s.get('users')).json.users.find(u => u.handle === 'bob');
        const login = await s.post('login', { handle: 'bob', password: 'changeme' }, { creds: false });
        const bobToken = login.json.token;
        const bobAuth = { headers: { Authorization: `Bearer ${bobToken}` } };
        assert.equal((await s.get('me', bobAuth)).status, 200); // session works
        assert.equal((await s.post('admin/users/password', { id: bob.id, password: 'newpass1' })).status, 200);
        assert.equal((await s.get('me', bobAuth)).status, 401);  // old session dead
        assert.equal((await s.post('login', { handle: 'bob', password: 'changeme' }, { creds: false })).status, 401);
        assert.equal((await s.post('login', { handle: 'bob', password: 'newpass1' }, { creds: false })).status, 200);
        await s.post('admin/users/password', { id: bob.id, password: 'changeme' }); // restore
    });
});
