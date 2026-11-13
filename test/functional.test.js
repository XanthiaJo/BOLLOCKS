// Functional API tests: boot the real server on an isolated data dir and
// exercise routes end-to-end over HTTP — the same surface the browser uses.
//
// Coverage map lives in docs/tests.md. Seeded users: creamms/karima/blake/
// entropy75, all password 'changeme', all in room 1 ("The House", ownerless).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, mockLLM, pngCardBuffer, rawPath, until } from './helpers.js';

let s;
let llm;
before(async () => {
    s = await boot(tmp('data'));
    llm = await mockLLM('Kira: Mock reply!');
});
after(async () => { await s.stop(); await llm.close(); });

const pub = {
    get: p => s.get(p, { creds: false }),
    post: (p, b) => s.post(p, b, { creds: false }),
    raw: (m, p, o) => s.raw(m, p, { ...o, creds: false }),
};

// ---------- authentication & sessions ----------

describe('authentication', () => {
    test('bad credentials are rejected', async () => {
        const r = await pub.post('login', { handle: 'creamms', password: 'nope' });
        assert.equal(r.status, 401);
        assert.equal(r.json.error, 'bad credentials');
    });

    test('login returns a token and sets the mp_token cookie', async () => {
        const r = await s.login('creamms');
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
        const queryTok = await pub.get(`me?token=${s.token}`);
        assert.equal(queryTok.status, 200);
    });

    test('invalid and missing tokens are rejected', async () => {
        assert.equal((await pub.get('me?token=deadbeef')).status, 401);
        assert.equal((await s.raw('GET', '/api/me', { creds: false, headers: { Cookie: 'mp_token=deadbeef' } })).status, 401);
    });

    test('logout invalidates the session and clears the cookie', async () => {
        const out = await s.raw('GET', '/api/logout');
        assert.equal(out.status, 302);
        assert.equal(out.headers.get('location'), '/login.html');
        assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
        assert.equal((await s.get('me')).status, 401); // dead for bearer AND cookie
        await s.login('creamms'); // restore for the rest of the suite
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

// ---------- request gating ----------

describe('request gating', () => {
    const pages = ['/', '/index.html', '/characters.html', '/world.html', '/world-edit.html',
        '/memories.html', '/connection.html', '/profile.html', '/app.js', '/layout.js', '/layout.css'];

    test('every page and asset redirects to login when unauthenticated', async () => {
        for (const p of pages) {
            const r = await pub.raw('GET', p);
            assert.equal(r.status, 302, `${p} should redirect`);
            assert.equal(r.headers.get('location'), '/login.html', p);
        }
    });

    test('login.html stays public; missing files 404', async () => {
        const r = await pub.raw('GET', '/login.html');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/html/);
        assert.equal((await pub.raw('GET', '/nope.html')).status, 404);
    });

    test('unauthenticated API calls 401 — including avatars, backgrounds, stream', async () => {
        for (const p of ['me', 'rooms', 'cards', 'memories', 'avatar?id=1', 'roombg?id=1', 'stream?room=1', 'users'])
            assert.equal((await pub.get(p)).status, 401, p);
        assert.equal((await pub.get('no-such-route')).status, 401); // gate precedes 404
    });

    test('login, logout, version stay public', async () => {
        assert.equal((await pub.get('version')).status, 200);
        assert.ok((await pub.get('version')).json.version);
        assert.equal((await pub.post('login', {})).status, 400); // missing fields
        assert.equal((await pub.post('login', { handle: 'creamms', password: 'x' })).status, 401); // route reachable
        assert.equal((await pub.raw('GET', '/api/logout')).status, 302);
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

// ---------- profile ----------

describe('profile', () => {
    test('email and handle updates persist; handle conflicts 409', async () => {
        assert.equal((await s.post('me/update', { email: 'me@example.test' })).status, 200);
        assert.equal((await s.get('me')).json.email, 'me@example.test');
        assert.equal((await s.post('me/update', { handle: 'KARIMA' })).status, 409); // nocase
        assert.equal((await s.post('me/update', { handle: '' })).status, 400);
        assert.equal((await s.post('me/update', { handle: 'creamsicle' })).status, 200);
        assert.equal((await s.get('me')).json.handle, 'creamsicle');
        assert.equal((await s.post('me/update', { handle: 'creamms' })).status, 200);
    });

    test('password change verifies the current password', async () => {
        assert.equal((await s.post('me/password', {})).status, 400);
        assert.equal((await s.post('me/password', { current: 'wrong', password: 'newpw123' })).status, 403);
        assert.equal((await s.post('me/password', { current: 'changeme', password: 'newpw123' })).status, 200);
        const creds = [s.token, s.cookie];
        await s.login('creamms', 'newpw123');
        assert.equal((await s.post('me/password', { current: 'newpw123', password: 'changeme' })).status, 200);
        s.useCreds(...creds); // restore the original session (still valid)
        assert.equal((await s.get('me')).status, 200);
    });

    test('persona selection updates /api/me', async () => {
        const id = (await s.post('cards', { name: 'AltSelf' })).json.id;
        assert.equal((await s.post('persona', { cardId: id })).status, 200);
        assert.equal((await s.get('me')).json.persona.id, id);
        const old = (await s.get('cards')).json.cards.find(c => c.name === 'creamms' && !c.is_persona);
        assert.equal((await s.post('persona', { cardId: old.id })).status, 200); // restore
    });
});

// ---------- rooms & members ----------

describe('rooms and members', () => {
    let room, myCard, karimaCard;
    const asKarima = async fn => {
        const creds = [s.token, s.cookie];
        await s.login('karima');
        try { return await fn(); } finally { s.useCreds(...creds); }
    };

    before(async () => {
        room = (await s.post('rooms', { name: 'Suite Room' })).json.id;
        myCard = (await s.post('cards', { name: 'Kira', description: 'A test NPC.', tags: 'bot, test' })).json.id;
        karimaCard = await asKarima(async () =>
            (await s.post('cards', { name: 'Vex' })).json.id);
        await s.post('members', { room, cardId: myCard });
    });

    test('creating a room seats the owner persona; rooms list marks ownership', async () => {
        const r = (await s.get('rooms')).json.rooms.find(r => r.id === room);
        assert.equal(r.name, 'Suite Room');
        assert.equal(r.is_owner, 1);
        const members = (await s.get(`room?id=${room}`)).json.members;
        assert.equal(members.filter(m => m.kind === 'human').length, 1);
        assert.equal(members.find(m => m.kind === 'ai')?.card_name, 'Kira');
    });

    test('room list only shows rooms the user sits in', async () => {
        await asKarima(async () => {
            const rooms = (await s.get('rooms')).json.rooms;
            assert.ok(!rooms.some(r => r.id === room), 'private room leaked into another user\'s list');
        });
    });

    test('owner-only room routes reject non-owners', async () => {
        await asKarima(async () => {
            for (const [route, body] of [
                ['rooms/update', { id: room, name: 'Hijacked' }],
                ['rooms/delete', { id: room }],
                ['room/trigger', { room, mode: 'all' }],
                ['room/settings', { room, maxContext: 1 }],
                ['room/memsettings', { room, memProfile: 0 }],
                ['room/background', { room, png_b64: 'AA==' }],
                ['world/link', { room, book: 1 }],
                ['members', { room, userId: 1 }],
            ]) {
                const r = await s.post(route, body);
                assert.equal(r.status, 403, `${route} should be owner-only`);
            }
        });
        assert.equal((await s.get('rooms')).json.rooms.find(r => r.id === room).name, 'Suite Room');
    });

    test('membership rules: non-members cannot self-invite; userId is owner-only', async () => {
        await asKarima(async () => {
            assert.equal((await s.post('members', { room, cardId: myCard })).status, 403); // not hers
            assert.equal((await s.post('members', { room, cardId: karimaCard })).status, 403); // not a member
            assert.equal((await s.post('members', { room, cardId: 99999 })).status, 404);
            assert.equal((await s.post('members', { room, userId: 99 })).status, 403); // owner only
        });
        // Room owner invites a user — their persona is seated.
        const karima = (await s.get('users')).json.users.find(u => u.handle === 'karima');
        assert.equal((await s.post('members', { room, userId: karima.id })).status, 200);
        // Now a member, karima may seat her own cards — but nobody else's.
        await asKarima(async () => {
            assert.equal((await s.post('members', { room, cardId: karimaCard })).status, 200);
            assert.equal((await s.post('members', { room, cardId: myCard })).status, 403);
        });
        const members = (await s.get(`room?id=${room}`)).json.members;
        assert.ok(members.some(m => m.card_name === 'Vex'));
        assert.ok(members.some(m => m.kind === 'human' && m.handle === 'karima'));
    });

    test('removal: non-owners remove only their own', async () => {
        await asKarima(async () => {
            assert.equal((await s.post('members/remove', { room, cardId: myCard })).status, 403);
            assert.equal((await s.post('members/remove', { room, cardId: karimaCard })).status, 200);
        });
        const members = (await s.get(`room?id=${room}`)).json.members;
        assert.ok(!members.some(m => m.card_name === 'Vex'));
    });

    test('talkativeness: member sets own, owner sets any, others are refused', async () => {
        await s.post('members', { room, cardId: karimaCard }); // owner re-seats it
        await asKarima(async () => {
            assert.equal((await s.post('members/talkativeness', { room, cardId: myCard, value: 10 })).status, 403);
            assert.equal((await s.post('members/talkativeness', { room, cardId: karimaCard, value: 150 })).status, 200);
        });
        const m = (await s.get(`room?id=${room}`)).json.members.find(m => m.card_name === 'Vex');
        assert.equal(m.talkativeness, 100); // clamped
        assert.equal((await s.post('members/talkativeness', { room, cardId: myCard, value: 40 })).status, 200);
    });

    test('rename and delete are honoured for the owner', async () => {
        assert.equal((await s.post('rooms/update', { id: room, name: 'Renamed' })).status, 200);
        assert.equal((await s.get('rooms')).json.rooms.find(r => r.id === room).name, 'Renamed');
        assert.equal((await s.post('rooms/update', { id: room, name: 'Suite Room' })).status, 200);
    });

    test('room background set/get/remove', async () => {
        const png = pngCardBuffer({ name: 'x' }).toString('base64');
        assert.equal((await s.post('room/background', { room, png_b64: png })).status, 200);
        const bg = await s.raw('GET', `/api/roombg?id=${room}`);
        assert.equal(bg.status, 200);
        assert.match(bg.headers.get('content-type'), /image\/png/);
        assert.equal((await s.post('room/background/remove', { room })).status, 200);
        assert.equal((await s.get(`roombg?id=${room}`)).status, 404);
    });
});

// ---------- cross-user access control ----------

describe('access control', () => {
    // A private room karima is NOT in, with data inside it.
    let priv, privMem, privMsg, privBook, privEntry;
    const asKarima = async fn => {
        const creds = [s.token, s.cookie];
        await s.login('karima');
        try { return await fn(); } finally { s.useCreds(...creds); }
    };

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
            const blake = (await s.get('users')).json.users.find(u => u.handle === 'blake');
            assert.equal((await s.post('users/delete', { id: blake.id })).status, 403);
            assert.equal((await s.post('register', { handle: 'sneaky', password: 'pw' })).status, 403);
        });
        assert.ok((await s.get('users')).json.users.some(u => u.handle === 'blake'));
    });
});

// ---------- cards & avatars ----------

describe('cards and avatars', () => {
    test('card CRUD is owner-scoped', async () => {
        assert.equal((await s.post('cards', {})).status, 400);
        const id = (await s.post('cards', { name: 'Temp', description: 'd' })).json.id;
        assert.equal((await s.post('cards/update', { id, name: 'Temp2' })).status, 200);
        assert.ok((await s.get('cards')).json.cards.some(c => c.id === id && c.name === 'Temp2'));

        const creds = [s.token, s.cookie];
        await s.login('karima');
        assert.equal((await s.post('cards/update', { id, name: 'Stolen' })).status, 200); // silent no-op…
        assert.equal((await s.post('cards/delete', { id })).status, 200); // …same for delete
        s.useCreds(...creds);
        assert.ok((await s.get('cards')).json.cards.some(c => c.id === id && c.name === 'Temp2'));

        assert.equal((await s.post('cards/delete', { id })).status, 200);
        assert.ok(!(await s.get('cards')).json.cards.some(c => c.id === id));
    });

    test('avatar: fallback SVG, upload restricted to the owner', async () => {
        const id = (await s.post('cards', { name: 'NoPic' })).json.id;
        const svg = await s.raw('GET', `/api/avatar?id=${id}`);
        assert.equal(svg.status, 200);
        assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);

        const creds = [s.token, s.cookie];
        await s.login('karima');
        assert.equal((await s.post('cards/avatar', { id, png_b64: 'AA==' })).status, 403);
        s.useCreds(...creds);
        assert.equal((await s.post('cards/avatar', { id, png_b64: pngCardBuffer({}).toString('base64') })).status, 200);
        const png = await s.raw('GET', `/api/avatar?id=${id}`);
        assert.match(png.headers.get('content-type'), /image\/png/);
        await s.post('cards/delete', { id });
    });

    test('JSON and PNG card import normalize ST fields', async () => {
        const j = await s.post('cards/import', { card: { spec: 'chara_card_v2', data: { name: 'JsonBot', description: 'dj', tags: ['a'] } } });
        assert.equal(j.status, 200);
        assert.equal(j.json.name, 'JsonBot');
        const p = await s.post('cards/import', { png_b64: pngCardBuffer({ name: 'PngBot', description: 'dp' }).toString('base64') });
        assert.equal(p.status, 200);
        assert.equal(p.json.name, 'PngBot');
        assert.equal((await s.post('cards/import', { png_b64: Buffer.from('notapng').toString('base64') })).status, 400);
        for (const name of ['JsonBot', 'PngBot'])
            await s.post('cards/delete', { id: (await s.get('cards')).json.cards.find(c => c.name === name).id });
    });
});

// ---------- messages & SSE ----------

describe('messages and SSE', () => {
    test('say posts as the user persona; delete removes and broadcasts', async () => {
        const msg = await s.post('say', { room: 1, text: 'hello suite' });
        assert.equal(msg.json.kind, 'say');
        assert.equal(msg.json.name, 'creamms');
        const msgs = (await s.get('room?id=1')).json.messages;
        assert.ok(msgs.some(m => m.id === msg.json.id && m.text === 'hello suite'));
        assert.equal((await s.post('messages/delete', { id: msg.json.id })).status, 200);
        assert.equal((await s.post('messages/delete', { id: msg.json.id })).status, 404);
        assert.ok(!(await s.get('room?id=1')).json.messages.some(m => m.id === msg.json.id));
    });

    test('stream requires auth and fans out message/delete events', async () => {
        assert.equal((await pub.get('stream?room=1')).status, 401);
        const res = await fetch(`${s.base}/api/stream?room=1`, { headers: { Authorization: `Bearer ${s.token}` } });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let pending = null;
        const readFor = async (needle, what) => {
            const deadline = Date.now() + 4000;
            let buf = '';
            while (Date.now() < deadline && !buf.includes(needle)) {
                pending = pending || reader.read();
                const r = await Promise.race([pending, new Promise(x => setTimeout(() => x(null), 500))]);
                if (r === null) continue; // still waiting on the same read
                pending = null;
                if (r.done) throw new Error(`stream closed waiting for ${what}`);
                buf += dec.decode(r.value);
            }
            if (!buf.includes(needle)) throw new Error(`timed out waiting for ${what}`);
            return buf;
        };

        const msg = await s.post('say', { room: 1, text: 'stream check' });
        const ev = await readFor('"type":"message"', 'message event');
        assert.ok(ev.includes(msg.json.text));
        await s.post('messages/delete', { id: msg.json.id });
        await readFor('"type":"delete"', 'delete event');
        await reader.cancel();
    });
});

// ---------- world / lorebook ----------

describe('world books', () => {
    let book, entry;
    before(async () => {
        book = (await s.post('world/books', { name: 'Suite Lore' })).json.id;
    });

    test('book and entry CRUD with CSV keys', async () => {
        assert.equal((await s.post('world/books', {})).status, 400);
        entry = (await s.post('world', { book, comment: 'House', content: 'The house is old.', keys: 'house, aria', keysecondary: 'night' })).json.id;
        const e = (await s.get(`world?book=${book}`)).json.entries[0];
        assert.equal(e.id, entry);
        assert.deepEqual(new Set(JSON.parse(e.keys)), new Set(['house', 'aria'])); // key order is index-dependent
        assert.deepEqual(JSON.parse(e.keysecondary), ['night']);

        assert.equal((await s.post('world/update', { id: entry, content: 'New.', keys: 'hall' })).status, 200);
        const e2 = (await s.get(`world?book=${book}`)).json.entries[0];
        assert.equal(e2.content, 'New.');
        assert.deepEqual(JSON.parse(e2.keys), ['hall']); // keys replaced wholesale
        assert.deepEqual(JSON.parse(e2.keysecondary), []); // untouched secondary cleared with primary
    });

    test('ST lorebook JSON import', async () => {
        const r = await s.post('world/import', {
            name: 'Imported', book: { entries: { 0: { key: ['goblin'], keysecondary: ['cave'], content: 'Goblins lurk.', comment: 'g' } } },
        });
        assert.equal(r.status, 200);
        assert.equal(r.json.count, 1);
        const e = (await s.get(`world?book=${r.json.id}`)).json.entries[0];
        assert.equal(e.content, 'Goblins lurk.');
        assert.equal((await s.post('world/import', { name: 'Empty', book: { entries: {} } })).status, 400);
        assert.equal((await s.post('world/books/delete', { id: r.json.id })).status, 200);
    });

    test('linking a book to a room is owner-only; deletion cascades', async () => {
        const room = (await s.post('rooms', { name: 'Lore room' })).json.id;
        assert.equal((await s.post('world/link', { room, book })).status, 200);
        const linked = (await s.get('world/books')).json.rooms.find(r => r.id === room);
        assert.equal(linked.world_books_id_fk, book);
        assert.equal((await s.post('world/link', { room })).status, 200); // unlink
        assert.equal((await s.post('world/delete', { id: entry })).status, 200);
        assert.equal((await s.post('world/books/delete', { id: book })).status, 200);
        assert.equal((await s.get(`world?book=${book}`)).json.entries.length, 0);
        assert.equal((await s.post('rooms/delete', { id: room })).status, 200);
    });
});

// ---------- memories ----------

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

// ---------- connection profiles ----------

describe('api and memory profiles', () => {
    test('profile CRUD; first is auto-active; key never leaves the API', async () => {
        const p1 = (await s.post('profiles', { name: 'Mock', apiUrl: `${llm.url}/v1`, model: 'mock-7b', key: 'secret' })).json.id;
        const p2 = (await s.post('profiles', { name: 'Second', apiUrl: 'http://127.0.0.1:9/v1', model: 'm' })).json.id;
        let profiles = (await s.get('profiles')).json.profiles;
        assert.equal(profiles.find(p => p.id === p1).active, 1);
        assert.equal(profiles.find(p => p.id === p2).active, 0);
        assert.ok(profiles.every(p => !('key' in p) && p.has_key !== undefined), 'api key must not be exposed');

        assert.equal((await s.post('profiles/activate', { id: p2 })).status, 200);
        profiles = (await s.get('profiles')).json.profiles;
        assert.deepEqual(profiles.map(p => [p.id, p.active]), [[p1, 0], [p2, 1]]);
        assert.equal((await s.post('profiles/activate', { id: p1 })).status, 200);

        assert.equal((await s.post('profiles/update', { id: p2, name: 'Second2', apiUrl: 'http://x/v1', model: 'y' })).status, 200);
        assert.equal((await s.post('profiles/delete', { id: p2 })).status, 200);
    });

    test('/api/models proxies the connection; failures surface as 502', async () => {
        const r = await s.post('models', { apiUrl: `${llm.url}/v1` });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.models, ['mock-13b', 'mock-7b']);
        assert.equal((await s.post('models', {})).status, 400);
        assert.equal((await s.post('models', { apiUrl: 'http://127.0.0.1:9/v1' })).status, 502);
    });

    test('memprofile CRUD and room assignment', async () => {
        const mp = (await s.post('memprofiles', { name: 'TestMem', every: 5, budget: 400 })).json.id;
        assert.ok((await s.get('memprofiles')).json.profiles.some(p => p.mem_profiles_id_pk === mp));
        assert.equal((await s.post('memprofiles/update', { id: mp, name: 'TestMem2' })).status, 200);
        const room = (await s.post('rooms', { name: 'MP room' })).json.id;
        assert.equal((await s.post('room/memsettings', { room, memProfile: mp })).status, 200);
        assert.equal((await s.get('rooms')).json.rooms.find(r => r.id === room).mem_profiles_id_fk, mp);
        assert.equal((await s.post('memprofiles/delete', { id: mp })).status, 200);
        // Room re-pointed at another profile rather than left dangling.
        assert.notEqual((await s.get('rooms')).json.rooms.find(r => r.id === room).mem_profiles_id_fk, mp);
        await s.post('rooms/delete', { id: room });
    });
});

// ---------- generation against the mock LLM ----------

describe('generation (mock LLM)', () => {
    let room, card;
    before(async () => {
        room = (await s.post('rooms', { name: 'Gen room' })).json.id;
        card = (await s.post('cards', { name: 'Kira', description: 'Kira is {{char}}.' })).json.id;
        await s.post('members', { room, cardId: card });
        await s.post('say', { room, text: 'Hi Kira' });
    });
    after(async () => {
        await s.post('rooms/delete', { id: room });
        await s.post('cards/delete', { id: card });
    });

    test('/api/generate posts an assembled prompt and stores the reply', async () => {
        llm.requests.length = 0;
        const r = await s.post('generate', { room, card });
        assert.equal(r.status, 200);
        assert.equal(r.json.kind, 'ai');
        assert.equal(r.json.text, 'Mock reply!'); // leading "Kira:" tag stripped
        assert.equal(r.json.name, 'Kira');

        // The mock saw the real request — assert on prompt assembly.
        const req = JSON.parse(llm.requests.find(r => r.url.endsWith('/chat/completions')).body);
        assert.equal(req.messages[0].role, 'system');
        assert.match(req.messages[0].content, /Kira is Kira/); // {{char}} substituted
        assert.equal(req.messages.at(-1).content, 'Kira:'); // trailing speaker nudge
        const stats = (await s.get(`genstats?room=${room}`)).json.stats;
        assert.equal(stats.card, 'Kira');
        assert.equal(stats.prompt_tokens, 42);
    });

    test('generate with no AI member 404s; no connection surfaces a 500', async () => {
        assert.equal((await s.post('generate', { room: 1 })).status, 404); // room 1 is all humans
        const creds = [s.token, s.cookie];
        await s.login('karima'); // karima has no api profile
        const kroom = (await s.post('rooms', { name: 'K room' })).json.id;
        const kcard = (await s.post('cards', { name: 'Solo' })).json.id;
        await s.post('members', { room: kroom, cardId: kcard });
        const r = await s.post('generate', { room: kroom, card: kcard });
        assert.equal(r.status, 500);
        assert.match(r.json.error, /no API connection/);
        s.useCreds(...creds);
    });

    test("trigger 'all' fires AI replies after a say", async () => {
        await s.post('room/trigger', { room, mode: 'all' });
        await s.post('members/talkativeness', { room, cardId: card, value: 100 });
        const before = (await s.get(`room?id=${room}`)).json.messages.length;
        await s.post('say', { room, text: 'anyone there?' });
        const msgs = await until(async () => {
            const m = (await s.get(`room?id=${room}`)).json.messages;
            return m.length === before + 2 ? m : null;
        }, 'auto AI reply');
        assert.equal(msgs.at(-1).kind, 'ai');
        assert.equal(msgs.at(-1).text, 'Mock reply!');
    });

    test("trigger 'named' fires only when the character is mentioned", async () => {
        await s.post('room/trigger', { room, mode: 'named' });
        const count = async () => (await s.get(`room?id=${room}`)).json.messages.filter(m => m.kind === 'ai').length;
        const n = await count();
        await s.post('say', { room, text: 'nothing addressed' });
        await new Promise(r => setTimeout(r, 300));
        assert.equal(await count(), n); // no reply
        await s.post('say', { room, text: 'hey Kira, ping' });
        await until(async () => (await count()) === n + 1 ? true : null, 'named-trigger reply');
    });
});

// ---------- user admin ----------

describe('users', () => {
    test('list shows seeded users; deleting self or unknown is refused', async () => {
        const users = (await s.get('users')).json.users;
        assert.deepEqual(users.map(u => u.handle), ['creamms', 'karima', 'blake', 'entropy75']);
        const me = users.find(u => u.handle === 'creamms');
        assert.equal((await s.post('users/delete', { id: me.id })).status, 400);
        assert.equal((await s.post('users/delete', { handle: 'ghost' })).status, 400);
    });
});
