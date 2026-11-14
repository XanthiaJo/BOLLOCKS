// Generation: the full LLM loop against a mock OpenAI-compatible endpoint —
// prompt assembly, reply parsing + speaker-tag stripping, genstats, and the
// ai_trigger policies that fire replies after a say.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmp, asUser, mockLLM, until } from './helpers.js';

let s;
let llm;
const asKarima = fn => asUser(s, 'alice')(fn);
before(async () => {
    s = await boot(tmp('data'));
    llm = await mockLLM('Kira: Mock reply!');
    await s.login('admin');
    // Point admin' active profile at the mock.
    await s.post('profiles', { name: 'Mock', apiUrl: `${llm.url}/v1`, model: 'mock-7b', key: 'secret' });
});
after(async () => { await s.stop(); await llm.close(); });

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

        // And it's persisted to prompt_logs for post-hoc inspection.
        const logs = (await s.get(`promptlog?room=${room}`)).json.logs;
        assert.equal(logs[0].kind, 'reply');
        assert.equal(logs[0].cards_id_fk, card);
        assert.equal(logs[0].response, 'Kira: Mock reply!'); // raw model output, before tag-strip
        assert.equal(logs[0].prompt_tokens, 42);
        assert.equal(logs[0].request.messages.at(-1).content, 'Kira:');
    });

    test('memory triggers phrase-match whole comma-separated keywords', async () => {
        const mem = (await s.post('memories', { room, content: 'SECRET PHRASE FACT', type: 'fact', triggers: 'dr pepper' })).json.id;
        const sysOf = async () => {
            llm.requests.length = 0;
            await s.post('generate', { room, card });
            return JSON.parse(llm.requests.at(-1).body).messages[0].content;
        };
        await s.post('say', { room, text: 'pass the pepper please' });
        assert.ok(!(await sysOf()).includes('SECRET PHRASE FACT')); // one word of the phrase doesn't fire it
        await s.post('say', { room, text: 'cracking open a dr pepper' });
        assert.ok((await sysOf()).includes('SECRET PHRASE FACT'));
        await s.post('memories/delete', { id: mem });
    });

    test('profile prompt_order reorders the system prompt', async () => {
        const mps = (await s.get('promptprofiles')).json;
        assert.equal(mps.promptBlocks.length, 11);
        const prof = mps.profiles[0];
        // 'history' stays last so the reversed sections still land in system.
        const rev = mps.promptBlocks.map(b => b.key).filter(k => k !== 'history').reverse().concat('history');
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order: rev });
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const sys = JSON.parse(llm.requests.at(-1).body).messages[0].content;
        // Reversed: instructions first, the main-prompt fallback last.
        assert.match(sys, /^You are Kira and ONLY Kira/);
        assert.ok(sys.indexOf('You are Kira and ONLY') < sys.indexOf('Description:\nKira is Kira'));
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order: null });
    });

    test('include_time injects a current-time block below history', async () => {
        const mps = (await s.get('promptprofiles')).json;
        const prof = mps.profiles[0];
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order: null, includeTime: 1 });
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const msgs = JSON.parse(llm.requests.at(-1).body).messages;
        assert.equal(msgs.at(-2).role, 'system'); // below 'history', before the nudge
        assert.match(msgs.at(-2).content, /Current time: \w+,? \d+ \w+ \d{4}, \d{2}:\d{2}\./);
        assert.match(msgs.at(-2).content, /Last message: just now\./);
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order: null, includeTime: 0 });
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const msgs2 = JSON.parse(llm.requests.at(-1).body).messages;
        assert.doesNotMatch(msgs2.at(-2).content, /Current time:/);
    });

    test("prompt_order injects sections below 'history' after the chat", async () => {
        const mps = (await s.get('promptprofiles')).json;
        const prof = mps.profiles[0];
        const keys = mps.promptBlocks.map(b => b.key);
        const order = keys.filter(k => k !== 'instructions' && k !== 'history').concat('history', 'instructions');
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order });
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const msgs = JSON.parse(llm.requests.at(-1).body).messages;
        assert.doesNotMatch(msgs[0].content, /ONLY Kira/); // instructions left the system prompt
        assert.equal(msgs.at(-2).role, 'system');          // appended after history…
        assert.match(msgs.at(-2).content, /You are Kira and ONLY Kira/);
        assert.equal(msgs.at(-1).content, 'Kira:');        // …and before the nudge
        await s.post('promptprofiles/update', { id: prof.prompt_profiles_id_pk, name: prof.name, order: null });
    });

    test('generate with no AI member 404s; no connection surfaces a 500', async () => {
        const humansOnly = (await s.post('rooms', { name: 'Humans only' })).json.id; // new rooms seat only the owner persona
        assert.equal((await s.post('generate', { room: humansOnly })).status, 404);
        await asKarima(async () => { // alice has no api profile
            const kroom = (await s.post('rooms', { name: 'K room' })).json.id;
            const kcard = (await s.post('cards', { name: 'Solo' })).json.id;
            await s.post('members', { room: kroom, cardId: kcard });
            const r = await s.post('generate', { room: kroom, card: kcard });
            assert.equal(r.status, 500);
            assert.match(r.json.error, /no API connection/);
        });
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
