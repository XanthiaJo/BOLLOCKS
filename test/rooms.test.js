// Room lifecycle and the membership permission matrix: owner-only routes,
// who may seat/remove whom, and talkativeness. Room 1 ("The House") holds
// the four seeded personas; Suite Room is owned by admin.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { boot, tmp, asUser, pngCardBuffer } from './helpers.js';

let s;
const asKarima = fn => asUser(s, 'alice')(fn);
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('rooms and members', () => {
    let room, myCard, aliceCard;

    before(async () => {
        room = (await s.post('rooms', { name: 'Suite Room' })).json.id;
        myCard = (await s.post('cards', { name: 'Kira', description: 'A test NPC.', tags: 'bot, test' })).json.id;
        aliceCard = await asKarima(async () =>
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
            assert.equal((await s.post('members', { room, cardId: aliceCard })).status, 403); // not a member
            assert.equal((await s.post('members', { room, cardId: 99999 })).status, 404);
            assert.equal((await s.post('members', { room, userId: 99 })).status, 403); // owner only
        });
        // Room owner invites a user — their persona is seated.
        const alice = (await s.get('users')).json.users.find(u => u.handle === 'alice');
        assert.equal((await s.post('members', { room, userId: alice.id })).status, 200);
        // Now a member, alice may seat her own cards — but nobody else's.
        await asKarima(async () => {
            assert.equal((await s.post('members', { room, cardId: aliceCard })).status, 200);
            assert.equal((await s.post('members', { room, cardId: myCard })).status, 403);
        });
        const members = (await s.get(`room?id=${room}`)).json.members;
        assert.ok(members.some(m => m.card_name === 'Vex'));
        assert.ok(members.some(m => m.kind === 'human' && m.handle === 'alice'));
    });

    test('removal: non-owners remove only their own', async () => {
        await asKarima(async () => {
            assert.equal((await s.post('members/remove', { room, cardId: myCard })).status, 403);
            assert.equal((await s.post('members/remove', { room, cardId: aliceCard })).status, 200);
        });
        const members = (await s.get(`room?id=${room}`)).json.members;
        assert.ok(!members.some(m => m.card_name === 'Vex'));
    });

    test('talkativeness: member sets own, owner sets any, others are refused', async () => {
        await s.post('members', { room, cardId: aliceCard }); // owner re-seats it
        await asKarima(async () => {
            assert.equal((await s.post('members/talkativeness', { room, cardId: myCard, value: 10 })).status, 403);
            assert.equal((await s.post('members/talkativeness', { room, cardId: aliceCard, value: 150 })).status, 200);
        });
        const m = (await s.get(`room?id=${room}`)).json.members.find(m => m.card_name === 'Vex');
        assert.equal(m.talkativeness, 100); // clamped
        assert.equal((await s.post('members/talkativeness', { room, cardId: myCard, value: 40 })).status, 200);
    });

    test('talkativeness is per-room: same card, different values', async () => {
        const room2 = (await s.post('rooms', { name: 'Annex' })).json.id;
        await s.post('members', { room: room2, cardId: myCard });
        assert.equal((await s.post('members/talkativeness', { room, cardId: myCard, value: 30 })).status, 200);
        assert.equal((await s.post('members/talkativeness', { room: room2, cardId: myCard, value: 90 })).status, 200);
        const inRoom = (await s.get(`room?id=${room}`)).json.members.find(m => m.cards_id_fk === myCard);
        const inAnnex = (await s.get(`room?id=${room2}`)).json.members.find(m => m.cards_id_fk === myCard);
        assert.equal(inRoom.talkativeness, 30);
        assert.equal(inAnnex.talkativeness, 90);
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

    test('deleting a room cascades messages, members and memories', async () => {
        const room2 = (await s.post('rooms', { name: 'Doomed' })).json.id;
        const card = (await s.post('cards', { name: 'Doomed Bot' })).json.id;
        await s.post('members', { room: room2, cardId: card });
        await s.post('say', { room: room2, text: 'farewell' });
        await s.post('memories', { room: room2, content: 'doomed memory' });
        assert.equal((await s.post('rooms/delete', { id: room2 })).status, 200);
        assert.ok(!(await s.get('rooms')).json.rooms.some(r => r.id === room2));
    });
});

// Legacy schema: members wrapped one card each and room_members pointed at
// them, so talkativeness was shared across rooms. The collapse must copy the
// member's value onto every room link and drop the members table.
test('migration copies talkativeness per-room from legacy members table', async () => {
    const dir = tmp('data');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'app.db'));
    db.exec(`CREATE TABLE rooms (rooms_id_pk INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE TABLE cards (cards_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_users_id_fk INTEGER, is_persona INTEGER DEFAULT 0);
        CREATE TABLE members (members_id_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            cards_id_fk INTEGER NOT NULL, talkativeness INTEGER DEFAULT 50);
        CREATE TABLE room_members (rooms_id_fk INTEGER NOT NULL,
            members_id_fk INTEGER NOT NULL,
            UNIQUE(rooms_id_fk, members_id_fk))`);
    db.exec(`INSERT INTO rooms (rooms_id_pk) VALUES (1),(2);
        INSERT INTO cards (cards_id_pk) VALUES (7);
        INSERT INTO members (members_id_pk,cards_id_fk,talkativeness) VALUES (3,7,42);
        INSERT INTO room_members (rooms_id_fk,members_id_fk) VALUES (1,3),(2,3)`);
    db.close();

    const srv = await boot(dir);
    try {
        const check = new DatabaseSync(path.join(dir, 'app.db'));
        const rows = check.prepare('SELECT rooms_id_fk, cards_id_fk, talkativeness FROM room_members ORDER BY rooms_id_fk').all().map(r => ({ ...r }));
        const hasMembers = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get();
        check.close();
        assert.deepEqual(rows, [
            { rooms_id_fk: 1, cards_id_fk: 7, talkativeness: 42 },
            { rooms_id_fk: 2, cards_id_fk: 7, talkativeness: 42 },
        ]);
        assert.equal(hasMembers, undefined);
    } finally {
        await srv.stop();
    }
});
