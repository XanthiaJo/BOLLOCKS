// Unit tests for the SillyTavern PNG card parser and field normalizer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { extractCardJson, normalizeCard } from '../src/pngcard.js';
import { pngCardBuffer } from './helpers.js';

function pngWithChunk(type, keyword, payload) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (t, d) => Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(d.length); return b; })(),
        Buffer.from(t, 'ascii'), d, Buffer.alloc(4),
    ]);
    const text = Buffer.concat([Buffer.from(keyword + '\0', 'ascii'), payload]);
    return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk(type, text), chunk('IEND', Buffer.alloc(0))]);
}

test('extractCardJson reads a tEXt chara chunk', () => {
    const card = { name: 'Aria', description: 'd' };
    const out = extractCardJson(pngCardBuffer(card));
    assert.deepEqual(out, card);
});

test('extractCardJson reads a compressed zTXt chunk and the ccv3 keyword', () => {
    const card = { name: 'V3' };
    for (const kw of ['chara', 'ccv3']) {
        const raw = JSON.stringify(card);
        const payload = Buffer.concat([Buffer.alloc(1), zlib.deflateSync(Buffer.from(Buffer.from(raw).toString('base64')))]);
        const out = extractCardJson(pngWithChunk('zTXt', kw, payload));
        assert.deepEqual(out, card, kw);
    }
});

test('extractCardJson returns null for junk and for PNGs without card data', () => {
    assert.equal(extractCardJson(Buffer.from('not a png')), null);
    assert.equal(extractCardJson(pngWithChunk('tEXt', 'comment', Buffer.from('hello'))), null);
    assert.equal(extractCardJson(pngWithChunk('tEXt', 'chara', Buffer.from('!!!notbase64json!!!'))), null);
});

test('normalizeCard maps v2 (data-wrapped) and v1 (flat) shapes', () => {
    const v2 = normalizeCard({ spec: 'chara_card_v2', data: { name: 'V2', first_mes: 'hi', tags: ['a'], creator_notes: 'n' } });
    assert.equal(v2.name, 'V2');
    assert.equal(v2.first_mes, 'hi');
    assert.equal(v2.creatorcomment, 'n');
    assert.deepEqual(v2.tags, ['a']);

    const v1 = normalizeCard({ name: 'V1', first_message: 'yo', tags: 'x, y ,z' });
    assert.equal(v1.name, 'V1');
    assert.equal(v1.first_mes, 'yo');
    assert.deepEqual(v1.tags, ['x', 'y', 'z']);
});

test('normalizeCard fills defaults for missing input', () => {
    const d = normalizeCard(null);
    assert.equal(d.name, 'Unnamed');
    assert.equal(d.description, '');
    assert.deepEqual(d.tags, []);
    assert.deepEqual(d.alternate_greetings, []);
});
