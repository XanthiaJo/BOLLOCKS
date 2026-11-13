// Character cards: owner-scoped CRUD, avatars (fallback SVG + upload),
// and ST card import (JSON + PNG with tEXt chunk).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, asUser, pngCardBuffer } from './helpers.js';

let s;
const asKarima = fn => asUser(s, 'karima')(fn);
before(async () => { s = await boot(tmp('data')); await s.login('creamms'); });
after(() => s.stop());

describe('cards and avatars', () => {
    test('card CRUD is owner-scoped', async () => {
        assert.equal((await s.post('cards', {})).status, 400);
        const id = (await s.post('cards', { name: 'Temp', description: 'd' })).json.id;
        assert.equal((await s.post('cards/update', { id, name: 'Temp2' })).status, 200);
        assert.ok((await s.get('cards')).json.cards.some(c => c.id === id && c.name === 'Temp2'));

        await asKarima(async () => {
            assert.equal((await s.post('cards/update', { id, name: 'Stolen' })).status, 200); // silent no-op…
            assert.equal((await s.post('cards/delete', { id })).status, 200); // …same for delete
        });
        assert.ok((await s.get('cards')).json.cards.some(c => c.id === id && c.name === 'Temp2'));

        assert.equal((await s.post('cards/delete', { id })).status, 200);
        assert.ok(!(await s.get('cards')).json.cards.some(c => c.id === id));
    });

    test('avatar: fallback SVG, upload restricted to the owner', async () => {
        const id = (await s.post('cards', { name: 'NoPic' })).json.id;
        const svg = await s.raw('GET', `/api/avatar?id=${id}`);
        assert.equal(svg.status, 200);
        assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);

        await asKarima(async () => {
            assert.equal((await s.post('cards/avatar', { id, png_b64: 'AA==' })).status, 403);
        });
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
