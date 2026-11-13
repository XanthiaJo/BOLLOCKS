// Profile page API: handle/email updates, password change, persona switch.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('profile', () => {
    test('email and handle updates persist; handle conflicts 409', async () => {
        assert.equal((await s.post('me/update', { email: 'me@example.test' })).status, 200);
        assert.equal((await s.get('me')).json.email, 'me@example.test');
        assert.equal((await s.post('me/update', { handle: 'ALICE' })).status, 409); // nocase
        assert.equal((await s.post('me/update', { handle: '' })).status, 400);
        assert.equal((await s.post('me/update', { handle: 'creamsicle' })).status, 200);
        assert.equal((await s.get('me')).json.handle, 'creamsicle');
        assert.equal((await s.post('me/update', { handle: 'admin' })).status, 200);
    });

    test('password change verifies the current password', async () => {
        assert.equal((await s.post('me/password', {})).status, 400);
        assert.equal((await s.post('me/password', { current: 'wrong', password: 'newpw123' })).status, 403);
        assert.equal((await s.post('me/password', { current: 'changeme', password: 'newpw123' })).status, 200);
        const creds = [s.token, s.cookie];
        await s.login('admin', 'newpw123');
        assert.equal((await s.post('me/password', { current: 'newpw123', password: 'changeme' })).status, 200);
        s.useCreds(...creds); // restore the original session (still valid)
        assert.equal((await s.get('me')).status, 200);
    });

    test('persona selection updates /api/me', async () => {
        const id = (await s.post('cards', { name: 'AltSelf' })).json.id;
        assert.equal((await s.post('persona', { cardId: id })).status, 200);
        assert.equal((await s.get('me')).json.persona.id, id);
        const old = (await s.get('cards')).json.cards.find(c => c.name === 'admin' && !c.is_persona);
        assert.equal((await s.post('persona', { cardId: old.id })).status, 200); // restore
    });
});
