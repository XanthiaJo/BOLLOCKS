// Chat messages and the SSE stream: say/delete round-trips and the
// live fan-out that keeps every client in sync.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, pub } from './helpers.js';

let s;
before(async () => { s = await boot(tmp('data')); await s.login('admin'); });
after(() => s.stop());

describe('messages and SSE', () => {
    test('say posts as the user persona; delete removes and broadcasts', async () => {
        const msg = await s.post('say', { room: 1, text: 'hello suite' });
        assert.equal(msg.json.kind, 'say');
        assert.equal(msg.json.name, 'admin');
        const msgs = (await s.get('room?id=1')).json.messages;
        assert.ok(msgs.some(m => m.id === msg.json.id && m.text === 'hello suite'));
        assert.equal((await s.post('messages/delete', { id: msg.json.id })).status, 200);
        assert.equal((await s.post('messages/delete', { id: msg.json.id })).status, 404);
        assert.ok(!(await s.get('room?id=1')).json.messages.some(m => m.id === msg.json.id));
    });

    test('stream requires auth and fans out message/delete events', async () => {
        assert.equal((await pub(s).get('stream?room=1')).status, 401);
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
