// STT sidecar: capability probe, audio forwarding to an OpenAI-shaped
// whisper endpoint, and room-member name correction on the transcript.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, tmp } from './helpers.js';

const freePort = () => new Promise((resolve, reject) => {
    const srv = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
    });
    srv.on('error', reject);
});

// Mock faster-whisper-server: any GET answers (aliveness probe), the
// transcriptions POST records its multipart body and returns fixed text.
async function mockWhisper(text = 'tell sir rackington the plan') {
    const port = await freePort();
    const reqs = [];
    const srv = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        reqs.push({ url: req.url, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
    });
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${port}`, reqs, close: () => new Promise(r => srv.close(r)) };
}

const postAudio = (s, room) => fetch(`${s.base}/api/stt?room=${room}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'audio/webm' },
    body: Buffer.from('RIFF-fake-audio-bytes'),
}).then(async r => ({ status: r.status, json: await r.json() }));

describe('STT sidecar', () => {
    let s, mock;
    before(async () => {
        mock = await mockWhisper();
        s = await boot(tmp('data'), { BOLLOCKS_STT_URL: mock.url });
        await s.login('admin');
    });
    after(async () => { await s.stop(); await mock.close(); });

    test('capability probe reports enabled when the sidecar answers', async () => {
        const d = await s.get('stt');
        assert.equal(d.status, 200);
        assert.equal(d.json.enabled, true);
    });

    test('forwards audio as multipart and corrects member names in the transcript', async () => {
        const card = (await s.post('cards', { name: 'SirRackington', description: 'x' })).json;
        await s.post('members', { room: 1, cardId: card.id });
        const r = await postAudio(s, 1);
        assert.equal(r.status, 200);
        assert.equal(r.json.text, 'tell SirRackington the plan');
        const up = mock.reqs.find(q => q.url.includes('transcriptions'));
        assert.ok(up, 'whisper never got the audio');
        assert.ok(up.body.includes('clip.webm'), 'no filename in multipart');
        assert.ok(up.body.includes('RIFF-fake-audio-bytes'), 'audio bytes not forwarded');
    });

    test('rejects non-members and empty bodies', async () => {
        assert.equal((await postAudio(s, 999)).status, 403);
        const r = await fetch(`${s.base}/api/stt?room=1`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'audio/webm' },
            body: '',
        });
        assert.equal(r.status, 400);
    });
});

describe('STT unconfigured', () => {
    let s;
    before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
    after(() => s.stop());

    test('reports disabled and refuses transcription', async () => {
        const d = await s.get('stt');
        assert.equal(d.json.enabled, false);
        assert.equal((await postAudio(s, 1)).status, 404);
    });
});
