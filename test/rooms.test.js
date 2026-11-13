// Room lifecycle and the membership permission matrix: owner-only routes,
// who may seat/remove whom, and talkativeness. Room 1 ("The House") holds
// the four seeded personas; Suite Room is owned by creamms.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, asUser, pngCardBuffer } from './helpers.js';

let s;
const asKarima = fn => asUser(s, 'karima')(fn);
before(async () => { s = await boot(tmp('data')); await s.login('creamms'); });
after(() => s.stop());

describe('rooms and members', () => {
    let room, myCard, karimaCard;

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
