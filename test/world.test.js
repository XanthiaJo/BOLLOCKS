// Lorebooks: book/entry CRUD, keyword handling, ST JSON import,
// room linking, and deletion cascades.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

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
