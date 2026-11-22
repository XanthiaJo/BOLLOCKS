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

    test('memory triggers match whole words across the full fetched history', async () => {
        const mem = (await s.post('memories', { room, content: 'KING FACT', type: 'fact', triggers: 'king' })).json.id;
        const sysOf = async () => {
            llm.requests.length = 0;
            await s.post('generate', { room, card });
            return JSON.parse(llm.requests.at(-1).body).messages[0].content;
        };
        // Substring inside another word ("looking") must not fire.
        await s.post('say', { room, text: 'I am looking at the door' });
        assert.ok(!(await sysOf()).includes('KING FACT'));
        // Whole-word plural fires…
        await s.post('say', { room, text: 'long live the kings' });
        assert.ok((await sysOf()).includes('KING FACT'));
        // …and still fires once the trigger is >3 messages back — the scan
        // window is the whole fetched history, not the last few lines.
        for (let i = 0; i < 5; i++) await s.post('say', { room, text: 'unrelated chatter ' + i });
        assert.ok((await sysOf()).includes('KING FACT'));
        await s.post('memories/delete', { id: mem });
    });

    test('profile prompt_order reorders the system prompt', async () => {
        const mps = (await s.get('promptprofiles')).json;
        assert.equal(mps.promptBlocks.length, 14);
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
        await s.post('room/trigger', { room, mode: 'manual' });
    });

    test("trigger 'all' chains replies — the second AI sees the first reply", async () => {
        // Fresh room so no earlier 'Mock reply!' pollutes the assertion.
        const room2 = (await s.post('rooms', { name: 'Chain room' })).json.id;
        const c2 = (await s.post('cards', { name: 'Moss' })).json.id;
        try {
            await s.post('members', { room: room2, cardId: card });
            await s.post('members', { room: room2, cardId: c2 });
            await s.post('room/trigger', { room: room2, mode: 'all' });
            await s.post('members/talkativeness', { room: room2, cardId: card, value: 100 });
            await s.post('members/talkativeness', { room: room2, cardId: c2, value: 100 });
            llm.requests.length = 0;
            const before = (await s.get(`room?id=${room2}`)).json.messages.length;
            await s.post('say', { room: room2, text: 'hello both' });
            const msgs = await until(async () => {
                const m = (await s.get(`room?id=${room2}`)).json.messages;
                return m.length === before + 3 ? m : null;
            }, 'two chained AI replies');
            assert.equal(msgs.at(-2).kind, 'ai');
            assert.equal(msgs.at(-1).kind, 'ai');
            // Sequential: exactly two completions calls; the first prompt has
            // no prior reply, the second carries the first reply in history.
            const reqs = llm.requests.filter(r => r.url.endsWith('/chat/completions')).map(r => r.body);
            assert.equal(reqs.length, 2);
            assert.ok(!reqs[0].includes('Mock reply!'), 'first prompt has no prior AI reply');
            assert.ok(reqs[1].includes('Mock reply!'), 'second prompt sees the first reply');
        } finally {
            await s.post('rooms/delete', { id: room2 });
            await s.post('cards/delete', { id: c2 });
        }
    });

    test("extraction strips the '(triggers: …)' label — it's not a keyword", async () => {
        const ext = await mockLLM('- [fact] Wren keeps biscuits in the blue tin. (triggers: Biscuits, Tin)');
        try {
            const profId = (await s.post('profiles', { name: 'Extract', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'Ext', auto: true, every: 1, triggers: true, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Mem room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            const wren = (await s.post('cards', { name: 'Wren', description: 'Wren is a kettle-bodied robot.' })).json.id;
            await s.post('members', { room: mroom, cardId: wren });
            await s.post('say', { room: mroom, text: 'Wren offered me tea.' });
            const mems = await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                return m?.length ? m : null;
            }, 'smart memory');
            // Extraction sees member card sheets as authoritative context.
            const extReq = JSON.parse(ext.requests.at(-1).body);
            assert.match(extReq.messages.at(-1).content, /Wren is a kettle-bodied robot\./);
            assert.equal(mems[0].triggers, 'biscuits,tin');
            assert.doesNotMatch(mems[0].content, /triggers/i);
            await s.post('rooms/delete', { id: mroom });
            await s.post('cards/delete', { id: wren });
        } finally { await ext.close(); }
    });

    test('untriggered memories are canon — always injected, in their own block', async () => {
        const mem = (await s.post('memories', { room, content: 'CANON TRUTH', type: 'fact' })).json.id;
        const trig = (await s.post('memories', { room, content: 'TRIGGERED FACT', type: 'fact', triggers: 'nevermatches' })).json.id;
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const sys = JSON.parse(llm.requests.at(-1).body).messages[0].content;
        assert.match(sys, /Canon:\n- CANON TRUTH/);
        assert.ok(!sys.includes('Memories:\n- CANON TRUTH')); // not double-injected
        assert.ok(!sys.includes('TRIGGERED FACT')); // unmet keywords stay out of both blocks
        await s.post('memories/delete', { id: mem });
        await s.post('memories/delete', { id: trig });
    });

    test('arcs: API lifecycle and open-thread injection', async () => {
        const arcId = (await s.post('arcs', { room, title: 'The stolen map', summary: 'Kira suspects the guild' })).json.id;
        const arcs = (await s.get(`arcs?room=${room}`)).json.arcs;
        assert.equal(arcs[0].status, 'open');
        assert.equal(arcs[0].origin, 'user'); // API-created threads are manual
        const sysOf = async () => {
            llm.requests.length = 0;
            await s.post('generate', { room, card });
            return JSON.parse(llm.requests.at(-1).body).messages[0].content;
        };
        assert.match(await sysOf(), /Open threads:\n- The stolen map — Kira suspects the guild/);
        await s.post('arcs/resolve', { id: arcId });
        assert.doesNotMatch(await sysOf(), /stolen map/); // resolved threads leave the prompt
        assert.equal((await s.post('arcs/delete', { id: arcId })).status, 200);
    });

    test('arc close consolidates the span and folds smart memories under it', async () => {
        const ext = await mockLLM('Wren hid the poison in the tin. (triggers: poison)');
        try {
            const profId = (await s.post('profiles', { name: 'ExtractCons', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'ExtCons', every: 1, triggers: true, profileId: profId, arcProfileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Cons room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            const mcard = (await s.post('cards', { name: 'Narrator' })).json.id;
            await s.post('members', { room: mroom, cardId: mcard });
            const arcId = (await s.post('arcs', { room: mroom, title: 'The Poisoning' })).json.id;
            await s.post('say', { room: mroom, text: 'Wren looked shifty.' });
            // Extraction writes the span's smart memory first.
            await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                return m?.length ? m : null;
            }, 'smart memory');
            // Resolving the arc consolidates: the chronicler's reply becomes
            // the chapter summary and the span's triggered memory folds in.
            await s.post('arcs/resolve', { id: arcId });
            await until(async () => {
                const a = (await s.get(`arcs?room=${mroom}`)).json.arcs[0];
                return a?.summary?.includes('poison in the tin') ? a : null;
            }, 'consolidated summary');
            // Point generation back at the main mock to read its prompt.
            const mockId = (await s.get('profiles')).json.profiles.find(p => p.name === 'Mock').id;
            await s.post('profiles/activate', { id: mockId });
            const sysOf = async () => {
                llm.requests.length = 0;
                await s.post('generate', { room: mroom, card: mcard });
                return JSON.parse(llm.requests.find(r => r.url.endsWith('/chat/completions')).body).messages[0].content;
            };
            // No trigger in context → neither the chapter nor the detail injects.
            assert.ok(!(await sysOf()).includes('poison'));
            // The folded detail's trigger pulls the whole chapter back up,
            // detail riding under the headline as an indented sub-line.
            await s.post('say', { room: mroom, text: 'where did the poison go?' });
            const fired = await sysOf();
            assert.match(fired, /Earlier events:\n- The Poisoning — Wren hid the poison in the tin/);
            assert.match(fired, /\n {2}- Wren hid the poison in the tin/);
            await s.post('rooms/delete', { id: mroom });
            await s.post('cards/delete', { id: mcard });
        } finally { await ext.close(); }
    });

    test('extraction parses [arc*] tags and keeps typed memory tags', async () => {
        const ext = await mockLLM('- [event] Wren offered tea.\n- [arc-open] The tea debt — Wren owes a service.\n- [arc] The tea debt — Wren promised biscuits too.');
        try {
            const profId = (await s.post('profiles', { name: 'ExtractArc', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'ExtArc', auto: true, every: 1, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Arc room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            await s.post('say', { room: mroom, text: 'Wren offered me tea.' });
            const arcs = await until(async () => {
                const a = (await s.get(`arcs?room=${mroom}`)).json.arcs;
                return a?.length ? a : null;
            }, 'open arc');
            // [arc-open] created it; the [arc] beat overwrote the summary.
            assert.equal(arcs[0].title, 'The tea debt');
            assert.equal(arcs[0].status, 'open');
            assert.equal(arcs[0].origin, 'smart'); // extraction-opened thread
            assert.match(arcs[0].summary, /biscuits/);
            // The memory bullet kept its [event] type instead of flattening to fact.
            const mems = await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                return m?.length ? m : null;
            }, 'smart memory');
            assert.equal(mems[0].type, 'event');
            await s.post('rooms/delete', { id: mroom });
        } finally { await ext.close(); }
    });

    test('extraction stores only one memory per run even when the model returns several', async () => {
        const ext = await mockLLM('- [fact] Wren keeps biscuits in the blue tin.\n- [event] Wren offered tea.\n- [preference] Wren prefers black tea.');
        try {
            const profId = (await s.post('profiles', { name: 'Extract1', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'Ext1', auto: true, every: 1, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Mem one room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            await s.post('say', { room: mroom, text: 'Wren offered me tea.' });
            const mems = await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                return m?.length ? m : null;
            }, 'smart memory');
            await new Promise(r => setTimeout(r, 200)); // let any extra inserts land
            assert.equal((await s.get(`memories?card=0&room=${mroom}`)).json.memories.length, 1);
            assert.equal(mems[0].content, 'Wren keeps biscuits in the blue tin.');
            await s.post('rooms/delete', { id: mroom });
        } finally { await ext.close(); }
    });

    test('scene-state rows inject as a Scene block, never canon', async () => {
        const st = (await s.post('memories', { room, content: 'Wren is in the kitchen', type: 'state' })).json.id;
        llm.requests.length = 0;
        await s.post('generate', { room, card });
        const sys = JSON.parse(llm.requests.at(-1).body).messages[0].content;
        assert.match(sys, /Scene:\n- Wren is in the kitchen/);
        assert.ok(!sys.includes('Canon:\n- Wren is in the kitchen'));
        await s.post('memories/delete', { id: st });
    });

    test('scene-state pass diffs a keyed JSON set — supersedes changed, tombstones absent', async () => {
        // One mock serves both calls: the extraction prompt gets a fact
        // bullet; the state prompt (asks for a "keyed set") gets a different
        // JSON set per run.
        let stateCalls = 0;
        const ext = await mockLLM(body => body.includes('keyed set')
            ? (++stateCalls === 1
                ? '{"Wren":"in the kitchen","blue tin":"on the counter","hearth fire":"burning"}'
                : '{"Wren":"by the door","blue tin":"on the counter"}')
            : '- [fact] Wren keeps biscuits in the blue tin.');
        try {
            const profId = (await s.post('profiles', { name: 'State', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'State', auto: true, every: 1,
                state: 1, stateEvery: 1, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'State room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            const states = async () =>
                ((await s.get(`memories?card=0&room=${mroom}`)).json.memories || []).filter(m => m.type === 'state');
            await s.post('say', { room: mroom, text: 'scene one' });
            const first = await until(async () => {
                const st = await states();
                return st.length === 3 ? st : null;
            }, 'first snapshot');
            const byKey = Object.fromEntries(first.map(m => [m.state_key, m]));
            assert.equal(byKey['Wren'].content, 'Wren — in the kitchen');
            assert.equal(byKey['blue tin'].content, 'blue tin — on the counter');
            await s.post('say', { room: mroom, text: 'scene two' });
            // Second run: Wren's new value supersedes via a fresh row (the
            // old one stays as history), the unchanged tin keeps its row,
            // the absent fire is retracted as a self-referencing tombstone.
            const all = await until(async () => {
                const st = await states();
                const live = st.filter(m => !m.superseded_by_memories_id_fk);
                return live.length === 2 && live.some(m => m.content === 'Wren — by the door') ? st : null;
            }, 'diffed snapshot');
            const live = all.filter(m => !m.superseded_by_memories_id_fk);
            const liveByKey = Object.fromEntries(live.map(m => [m.state_key, m]));
            const newWren = liveByKey['Wren'];
            assert.notEqual(newWren.memories_id_pk, byKey['Wren'].memories_id_pk);
            const oldWren = all.find(m => m.memories_id_pk === byKey['Wren'].memories_id_pk);
            assert.equal(oldWren.superseded_by_memories_id_fk, newWren.memories_id_pk);
            assert.equal(liveByKey['blue tin'].memories_id_pk, byKey['blue tin'].memories_id_pk);
            const fire = all.find(m => m.state_key === 'hearth fire');
            assert.equal(fire.superseded_by_memories_id_fk, fire.memories_id_pk);
            assert.ok(live.every(m => !m.triggers)); // state is never trigger-gated
            await s.post('rooms/delete', { id: mroom });
        } finally { await ext.close(); }
    });

    test('extraction [supersede N] retires the older smart memory', async () => {
        const ext = await mockLLM('- [supersede 1][fact] The blue tin is now empty.');
        try {
            const profId = (await s.post('profiles', { name: 'Sup', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'Sup', auto: true, every: 1, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Sup room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            // A live smart memory the writer can retire — seeded via the API
            // (origin 'user') then promoted, since extraction is the only
            // producer of 'smart' rows.
            const oldId = (await s.post('memories', { room: mroom, content: 'The blue tin is full of biscuits.', type: 'fact', triggers: 'tin' })).json.id;
            await s.post('memories/update', { id: oldId, origin: 'smart' });
            await s.post('say', { room: mroom, text: 'Wren ate the last biscuit.' });
            const mems = await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                const old = m?.find(x => x.memories_id_pk === oldId);
                return old?.superseded_by_memories_id_fk ? m : null;
            }, 'superseded memory');
            const old = mems.find(m => m.memories_id_pk === oldId);
            const neu = mems.find(m => m.memories_id_pk === old.superseded_by_memories_id_fk);
            assert.equal(neu.content, 'The blue tin is now empty.');
            assert.equal(neu.type, 'fact');
            // The extraction prompt carried the numbered current-memories list.
            assert.match(ext.requests.at(-1).body, /Current memories.*1\) \[fact\] The blue tin is full/s);
            await s.post('rooms/delete', { id: mroom });
        } finally { await ext.close(); }
    });

    test('extraction auto-dedupes an untagged retelling of a live event', async () => {
        const ext = await mockLLM('- [event] Sir Rackington cleared Buddy and named Blake the flapjack thief. (triggers: flapjack, crumbs, blake, culprit)');
        try {
            const profId = (await s.post('profiles', { name: 'Ded', apiUrl: `${ext.url}/v1`, model: 'mock-7b' })).json.id;
            const mp = (await s.post('memprofiles', { name: 'Ded', every: 1, profileId: profId })).json.id;
            const mroom = (await s.post('rooms', { name: 'Ded room' })).json.id;
            await s.post('room/memsettings', { room: mroom, memProfile: mp });
            const oldId = (await s.post('memories', { room: mroom, content: 'A flapjack vanished overnight, leaving crumbs near Buddy.', type: 'event', triggers: 'flapjack,crumbs,buddy,mystery' })).json.id;
            await s.post('memories/update', { id: oldId, origin: 'smart' });
            // No [supersede] tag in the mock — the script must chain the
            // retelling on trigger overlap by itself.
            await s.post('say', { room: mroom, text: 'case closed' });
            const mems = await until(async () => {
                const m = (await s.get(`memories?card=0&room=${mroom}`)).json.memories;
                const old = m?.find(x => x.memories_id_pk === oldId);
                return old?.superseded_by_memories_id_fk ? m : null;
            }, 'deduped memory');
            const old = mems.find(m => m.memories_id_pk === oldId);
            const neu = mems.find(m => m.memories_id_pk === old.superseded_by_memories_id_fk);
            assert.match(neu.content, /named Blake the flapjack thief/);
            await s.post('rooms/delete', { id: mroom });
        } finally { await ext.close(); }
    });
});
