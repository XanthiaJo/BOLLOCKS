// Auth + request-gating tests: sessions, token transports, first-run
// registration, and the static/API gates that keep logged-out users out.
// Seeded users: admin/alice/bob/carol, all password 'changeme',
// all in room 1 ("The House").
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, pub, rawPath } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); });
after(() => s.stop());

describe('authentication', () => {
    test('bad credentials are rejected', async () => {
        const r = await pub(s).post('login', { handle: 'admin', password: 'nope' });
        assert.equal(r.status, 401);
        assert.equal(r.json.error, 'bad credentials');
    });

    test('login returns a token and sets the mp_token cookie', async () => {
        const r = await s.login('admin');
        assert.ok(r.json.token.length > 10);
        const sc = r.headers.getSetCookie()[0];
        assert.match(sc, /^mp_token=/);
        assert.match(sc, /HttpOnly/);
        assert.match(sc, /SameSite=Lax/);
    });

    test('Bearer header, cookie, and ?token= all authenticate', async () => {
        assert.equal((await s.get('me')).status, 200); // bearer (and cookie)
        const cookieOnly = await s.raw('GET', '/api/me', { creds: false, headers: { Cookie: s.cookie } });
        assert.equal(cookieOnly.status, 200);
        const queryTok = await pub(s).get(`me?token=${s.token}`);
        assert.equal(queryTok.status, 200);
    });

    test('invalid and missing tokens are rejected', async () => {
        assert.equal((await pub(s).get('me?token=deadbeef')).status, 401);
        assert.equal((await s.raw('GET', '/api/me', { creds: false, headers: { Cookie: 'mp_token=deadbeef' } })).status, 401);
    });

    test('logout invalidates the session and clears the cookie', async () => {
        const out = await s.raw('GET', '/api/logout');
        assert.equal(out.status, 302);
        assert.equal(out.headers.get('location'), '/login.html');
        assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
        assert.equal((await s.get('me')).status, 401); // dead for bearer AND cookie
        await s.login('admin'); // restore for the rest of the suite
    });
});

describe('first-run registration (unseeded DB)', () => {
    let f;
    before(async () => { f = await boot(tmp('fresh'), { BOLLOCKS_SEED: '0' }); });
    after(() => f.stop());

    test('register is open only while zero users exist', async () => {
        assert.equal((await f.post('register', {}, { creds: false })).status, 400); // fields required
        const r = await f.post('register', { handle: 'founder', password: 'pw12345' }, { creds: false });
        assert.equal(r.status, 200);
        assert.ok(r.json.id);
        // Gate closes once a user exists.
        assert.equal((await f.post('register', { handle: 'second', password: 'pw' }, { creds: false })).status, 401);
    });

    test('registered user can log in; duplicate handles are refused', async () => {
        await f.login('founder', 'pw12345');
        assert.equal((await f.get('me')).json.handle, 'founder');
        assert.equal((await f.post('register', { handle: 'founder', password: 'x' })).status, 409);
        assert.equal((await f.post('register', { handle: 'FOUNDER', password: 'x' })).status, 409); // NOCASE
        assert.equal((await f.post('register', { handle: 'second', password: 'pw' })).status, 200);
    });

    test('only the admin (first user) may register further accounts', async () => {
        const creds = [f.token, f.cookie];
        await f.login('second', 'pw');
        assert.equal((await f.post('register', { handle: 'third', password: 'pw' })).status, 403);
        f.useCreds(...creds);
    });
});

describe('request gating', () => {
    const pages = ['/', '/index.html', '/characters.html', '/world.html', '/world-edit.html',
        '/memories.html', '/connection.html', '/profile.html', '/app.js', '/layout.js', '/layout.css'];

    test('every page and asset redirects to login when unauthenticated', async () => {
        for (const p of pages) {
            const r = await pub(s).raw('GET', p);
            assert.equal(r.status, 302, `${p} should redirect`);
            assert.equal(r.headers.get('location'), '/login.html', p);
        }
    });

    test('login.html stays public; missing files 404', async () => {
        const r = await pub(s).raw('GET', '/login.html');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/html/);
        assert.equal((await pub(s).raw('GET', '/nope.html')).status, 404);
    });

    test('unauthenticated API calls 401 — including avatars, backgrounds, stream', async () => {
        for (const p of ['me', 'rooms', 'cards', 'memories', 'avatar?id=1', 'roombg?id=1', 'stream?room=1', 'users'])
            assert.equal((await pub(s).get(p)).status, 401, p);
        assert.equal((await pub(s).get('no-such-route')).status, 401); // gate precedes 404
    });

    test('login, logout, version stay public', async () => {
        assert.equal((await pub(s).get('version')).status, 200);
        assert.ok((await pub(s).get('version')).json.version);
        assert.equal((await pub(s).post('login', {})).status, 400); // missing fields
        assert.equal((await pub(s).post('login', { handle: 'admin', password: 'x' })).status, 401); // route reachable
        assert.equal((await pub(s).raw('GET', '/api/logout')).status, 302);
    });

    test('authenticated requests serve pages and APIs; unknown routes 404', async () => {
        for (const p of pages) assert.equal((await s.raw('GET', p)).status, 200, p);
        assert.equal((await s.get('me')).status, 200);
        assert.equal((await s.get('no-such-route')).status, 404);
    });

    test('path traversal is refused', async () => {
        for (const p of ['/../src/server.js', '/%2e%2e/src/server.js', '/../AGENTS.md']) {
            assert.equal((await rawPath(s.base, p)).statusCode, 404, p);
            assert.equal((await rawPath(s.base, p, { Cookie: s.cookie })).statusCode, 404, p);
        }
    });
});
