import { db, activeProfile, MSG_SQL } from './db.js';
import { llmFetch, logPrompt, tok } from './lib/llm.js';
import { PROMPT_BLOCKS, memProfileFor } from './lib/memprompts.js';

// Latest prompt composition per room — exposed for the chat sidebar.
export const genStats = {};

/**
 * Server-side generation — the server owns the prompt AND the API call.
 * Prompt = card description (system) + recent messages (context). The API
 * config lives in the room owner's settings (user.settings JSON:
 * { apiUrl, model, key }) — read from DB, never reaches clients.
 */
export async function generateReply(roomId, card) {
    // Card's own profile wins; otherwise the card owner's active profile.
    // Everyone is responsible for their own API keys — never the room owner's.
    const p = card.api_profiles_id_fk
        ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=?').get(card.api_profiles_id_fk)
        : null;
    const conn = p ? { ...p, apiUrl: p.api_url } : activeProfile(card.owner_users_id_fk);
    if (!conn?.apiUrl) throw new Error('no API connection configured — set one on the Connection page');

    const history = db.prepare(
        MSG_SQL + ' WHERE m.rooms_id_fk=? ORDER BY m.messages_id_pk  DESC LIMIT 30'
    ).all(roomId).reverse();
    const lastSpeaker = [...history].reverse().find(m => m.kind === 'say')?.name || 'the user';

    // {{char}}/{{user}} macro substitution — ST cards are full of them.
    const sub = s => (s || '')
        .replace(/\{\{char\}\}/gi, card.name)
        .replace(/\{\{user\}\}/gi, lastSpeaker)
        .replace(/<user>/gi, lastSpeaker)
        .replace(/<USER>/gi, lastSpeaker);
    for (const k of ['description', 'personality', 'scenario', 'mes_example', 'first_message',
        'system_prompt', 'post_history_instructions'])
        card[k] = sub(card[k]);

    // Other characters in the scene — ST injects member context so NPCs
    // know who's present. Descriptions only; no full cards.
    const others = db.prepare(`SELECT c.name, c.description FROM room_members rm
        JOIN cards c ON c.cards_id_pk=rm.cards_id_fk WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 AND c.cards_id_pk!=?`)
        .all(roomId, card.id);

    // Trigger matching: whole-word (with an optional plural s) — substring
    // hits like "king" in "making" don't fire, "kings" does. Both world
    // entries and memory triggers scan the same haystack: the full fetched
    // history plus the generating card's fields.
    const wordHit = (hay, w) =>
        new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b').test(hay);
    // Keyword-triggered world entries: constant entries always in; keyed
    // entries fire when a key appears in recent chat or the card's fields.
    const scanText = (history.map(m => `${m.name} ${m.text}`).join('\n')
        + ' ' + (card.name || '') + ' ' + (card.description || '')).toLowerCase();
    const world = db.prepare(`SELECT e.* FROM world_entries e
        JOIN book_entries be ON be.world_entries_id_fk=e.world_entries_id_pk
        JOIN room_books rb ON rb.world_books_id_fk=be.world_books_id_fk
        WHERE rb.rooms_id_fk=? AND e.enabled=1 ORDER BY e.ord,e.world_entries_id_pk`).all(roomId)
        .filter(e => {
            if (e.constant) return true;
            const rows = db.prepare('SELECT word,kind FROM world_entry_keys WHERE world_entries_id_fk=?').all(e.world_entries_id_pk);
            const prim = rows.filter(r => r.kind==='primary').map(r => r.word);
            const sec = rows.filter(r => r.kind==='secondary').map(r => r.word);
            return prim.some(k => k && wordHit(scanText, k.toLowerCase()))
                && sec.every(k => !k || wordHit(scanText, k.toLowerCase()));
        });
    const worldText = world.length
        ? 'World info:\n' + world.map(e => e.content).join('\n\n')
        : null;

    // Long-term memories: shared room facts + this character's own.
    // Capped at the injection token budget (chars/4 estimate); a room may
    // follow a memory profile, which overrides the per-chat mem_* settings.
    const room = db.prepare('SELECT *, rooms_id_pk AS id FROM rooms WHERE rooms_id_pk=?').get(roomId);
    const mem = memProfileFor(room);
    const budget = mem?.mem_budget ?? 800;
    const refreshN = mem?.mem_refresh || 1;
    const refreshKey = room?.mem_refresh_count || 0;
    const injectMem = refreshN <= 1 || refreshKey % refreshN === 0;
    const cap = (rows, max, acc = 0) => { let used = acc; return rows.filter(r => (used += tok(r.content)) <= max); };
    const active = r => !r.triggers || r.triggers.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        .some(t => wordHit(scanText, t));
    const TRIG_SQL = `(SELECT GROUP_CONCAT(mt.word,',') FROM memory_triggers mt WHERE mt.memories_id_fk=m.memories_id_pk) AS triggers`;
    const HAS_TRIG = `EXISTS (SELECT 1 FROM memory_triggers mt WHERE mt.memories_id_fk=m.memories_id_pk)`;
    const NO_TRIG = `NOT ${HAS_TRIG}`;
    const LIVE = `m.superseded_by_memories_id_fk IS NULL`; // retracted rows never inject
    // Event bullets carry their created stamp — an event is a past truth,
    // and undated tellings read as contradictory claims about the present.
    const stamp = m => m.type === 'event' && m.created ? `(${m.created.slice(0, 16)}) ` : '';
    const roomMemsSel = db.prepare(`SELECT m.memories_id_pk AS id, m.content, m.type, m.created,${TRIG_SQL} FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND ${HAS_TRIG} AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk) ORDER BY m.memories_id_pk DESC`).all(roomId).reverse().filter(active);
    const roomMems = cap(roomMemsSel, budget, 0);
    const memsSel = db.prepare(`SELECT m.memories_id_pk AS id, m.content, m.type, m.created,${TRIG_SQL} FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk JOIN memory_cards mc ON mc.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND mc.cards_id_fk=? AND ${HAS_TRIG} AND ${LIVE} ORDER BY m.memories_id_pk DESC`)
        .all(roomId, card.id).reverse().filter(active);
    const mems = cap(memsSel, budget, roomMems.reduce((a, r) => a + tok(r.content), 0));

    // Canon: memories with no trigger keywords are always-true — injected
    // every generation, bypassing the refresh counter, capped by their own
    // budget. Shared canon + this card's canon both apply.
    const canonRows = cap(db.prepare(`SELECT m.content, m.type, m.created FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND m.type!='state' AND ${LIVE} AND ${NO_TRIG} AND (NOT EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk)
            OR EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk AND mc.cards_id_fk=?))
        ORDER BY m.memories_id_pk`).all(roomId, card.id), mem?.mem_canon_budget ?? 800);
    const canonText = canonRows.length ? 'Canon:\n' + canonRows.map(m => `- ${stamp(m)}${m.content}`).join('\n') : null;

    // Open story arcs: tracked threads the AI should keep advancing.
    const arcRows = cap(db.prepare(`SELECT title || CASE WHEN summary!='' THEN ' — ' || summary ELSE '' END AS content
        FROM room_arcs WHERE rooms_id_fk=? AND status='open' ORDER BY updated`).all(roomId), mem?.mem_arc_budget ?? 700);
    // Closed arcs are consolidated chapters: the headline injects when a
    // title word reappears in context OR a folded memory's trigger fires —
    // the detail pulls its chapter back up, and any matching details ride
    // under the headline as indented sub-lines.
    const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'my', 'his', 'her', 'our']);
    const folded = db.prepare(`SELECT m.memories_id_pk AS id, m.content, m.type, m.created, m.room_arcs_id_fk AS arcId,${TRIG_SQL}
        FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NOT NULL AND ${LIVE}`).all(roomId);
    const hitKids = folded.filter(active).reduce((m, c) => ((m[c.arcId] ||= []).push(c), m), {});
    const pastArcs = cap(db.prepare(`SELECT room_arcs_id_pk AS id, title, summary FROM room_arcs
        WHERE rooms_id_fk=? AND status!='open' AND summary!='' ORDER BY updated DESC`).all(roomId)
        .filter(a => hitKids[a.id]?.length
            || a.title.toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length > 2 && !STOP.has(w)).some(w => wordHit(scanText, w)))
        .map(a => ({ id: a.id, content: `- ${a.title} — ${a.summary}`
            + (hitKids[a.id] || []).map(c => `\n  - ${stamp(c)}${c.content}`).join('') })),
        mem?.mem_arc_budget ?? 700);
    const arcText = (arcRows.length || pastArcs.length)
        ? (arcRows.length ? 'Open threads:\n' + arcRows.map(a => '- ' + a.content).join('\n') : '')
            + (pastArcs.length ? (arcRows.length ? '\n\n' : '') + 'Earlier events:\n' + pastArcs.map(a => a.content).join('\n') : '')
        : null;

    // Scene state: the latest "what is true right now" snapshot — locations,
    // held objects, ongoing conditions. Always injected when present (it is
    // by definition relevant), never trigger-gated, own token budget. The
    // as-of stamp tells the model how old the sample is — sampled state,
    // not a truth claim.
    const sceneRows = cap(db.prepare(`SELECT m.content, m.created FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.type='state' AND m.room_arcs_id_fk IS NULL AND ${LIVE} ORDER BY m.memories_id_pk`).all(roomId),
        mem?.mem_state_budget ?? 400);
    const sceneText = sceneRows.length
        ? `Scene (as of ${sceneRows.map(r => r.created).sort().at(-1).slice(0, 16)}):\n` + sceneRows.map(m => '- ' + m.content).join('\n')
        : null;

    // Dormancy bookkeeping: a memory counts as fired only when it actually
    // reached the prompt — post-budget rows that never make the cut are
    // exactly what the dormancy sweep retires. Canon/state are exempt from
    // pruning so they aren't tracked.
    const firedIds = [...(injectMem ? [...roomMems, ...mems] : []),
        ...pastArcs.flatMap(a => hitKids[a.id] || [])].map(r => r.id);
    if (firedIds.length) {
        const wm = db.prepare('SELECT MAX(messages_id_pk) AS m FROM messages WHERE rooms_id_fk=?').get(roomId).m || 0;
        db.prepare(`UPDATE memories SET last_fired_messages_id_fk=?, last_fired_at=datetime('now')
            WHERE memories_id_pk IN (${firedIds.map(() => '?').join(',')})`).run(wm, ...firedIds);
    }

    const memText = (injectMem && (roomMems.length || mems.length))
        ? (mem?.mem_unified
            ? ['Memories:\n' + [...roomMems.map(m => `- ${stamp(m)}${m.content}`), ...mems.map(m => `- ${stamp(m)}${m.content}`)].join('\n')].join('')
            : [
                roomMems.length && 'What happened here:\n' + roomMems.map(m => `- ${stamp(m)}${m.content}`).join('\n'),
                mems.length && `Things ${card.name} remembers:\n` + mems.map(m => `- ${stamp(m)}${m.content}`).join('\n'),
            ].filter(Boolean).join('\n\n'))
        : null;

    // Prompt sections assemble in PROMPT_BLOCKS order — stable -> volatile for
    // prefix caching: card sheet fields and the member roster rarely change;
    // keyword-triggered world entries and freshly-extracted memories change
    // often, so they go last. Anything after a changed block re-bills, so
    // volatility decides position. A profile's mem_prompt_order overrides.
    const blocks = {
        main: card.system_prompt || `You are ${card.name}.`,
        description: card.description && `Description:\n${card.description}`,
        personality: card.personality && `Personality:\n${card.personality}`,
        scenario: card.scenario && `Scenario:\n${card.scenario}`,
        examples: card.mes_example && `Example dialogue:\n${card.mes_example}`,
        roster: others.length && `Also present in the scene:\n` +
            others.map(o => `${o.name}: ${o.description || o.name}`).join('\n'),
        canon: canonText,
        world: worldText,
        memories: memText,
        arcs: arcText,
        scene: sceneText,
        instructions: `You are ${card.name} and ONLY ${card.name} — an NPC in a shared roleplay. ` +
            `The other characters listed are separate people speaking for themselves; ` +
            `do NOT speak for them or imitate them. Write ONLY ${card.name}'s next message.` +
            (card.post_history_instructions ? ` ${card.post_history_instructions}` : ''),
    };
    // The card owner's active injection profile decides section order —
    // prompt layout follows the user, not whichever API profile generated.
    const inj = db.prepare('SELECT * FROM prompt_profiles WHERE users_id_fk=? AND active=1').get(card.owner_users_id_fk)
        || db.prepare('SELECT * FROM prompt_profiles WHERE users_id_fk=? ORDER BY prompt_profiles_id_pk LIMIT 1').get(card.owner_users_id_fk);
    // Current-time block — only when the active injection profile asks for
    // it. Most volatile block, so the default order puts it below 'history',
    // right before the reply nudge.
    let timeText = null;
    if (inj?.include_time) {
        const now = new Date();
        const fmt = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            + ', ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const lastAt = Date.parse((history.at(-1)?.send_date || '').replace(' ', 'T') + 'Z');
        const d = Number.isFinite(lastAt) ? Math.max(0, Date.now() - lastAt) : null;
        let ago = '';
        if (d != null) {
            ago = 'just now';
            for (const [ms, unit] of [[864e5, 'day'], [36e5, 'hour'], [6e4, 'minute']])
                if (d >= ms) { const n = Math.round(d / ms); ago = `${n} ${unit}${n === 1 ? '' : 's'} ago`; break; }
        }
        timeText = `Current time: ${fmt}.` + (ago ? ` Last message: ${ago}.` : '');
        blocks.time = timeText;
    }
    let order;
    try { order = JSON.parse(inj?.prompt_order || ''); } catch { order = null; }
    if (!Array.isArray(order)) order = [];
    const known = new Set(PROMPT_BLOCKS.map(b => b.key));
    order = order.filter(k => known.has(k));
    for (const b of PROMPT_BLOCKS) if (!order.includes(b.key)) order.push(b.key);
    // 'history' is a position marker, not a text block: everything above it
    // joins the system prompt; everything below is appended as a second
    // system message after the chat history, right before the reply nudge.
    const hi = order.indexOf('history');
    const system = order.slice(0, hi < 0 ? order.length : hi).map(k => blocks[k]).filter(Boolean).join('\n\n');
    const postSys = hi < 0 ? '' : order.slice(hi + 1).map(k => blocks[k]).filter(Boolean).join('\n\n');

    const parts = {
        'Main Prompt': tok(card.system_prompt || `You are ${card.name}.`),
        'World Info': tok(worldText),
        'Char Description': tok(card.description),
        'Char Personality': tok(card.personality),
        'Scenario': tok(card.scenario),
        'Chat Examples': tok(card.mes_example),
        'Other Characters': tok(others.map(o => o.name + (o.description || '')).join('')),
        'Post-History Instructions': tok(card.post_history_instructions),
        'Chat History': history.reduce((n, m) => n + tok(m.name + ' ' + m.text), 0),
    };
    parts.Memories = tok(memText);
    parts.Canon = tok(canonText);
    parts['Open Threads'] = tok(arcText);
    parts.Scene = tok(sceneText);
    parts['Current Time'] = tok(timeText);

    // Section texts for the chat sidebar's click-to-view prompt inspector.
    const texts = {
        'Main Prompt': card.system_prompt || `You are ${card.name}.`,
        'World Info': worldText,
        'Char Description': card.description,
        'Char Personality': card.personality,
        'Scenario': card.scenario,
        'Chat Examples': card.mes_example,
        'Other Characters': others.map(o => `${o.name}: ${o.description || o.name}`).join('\n'),
        'Post-History Instructions': card.post_history_instructions,
        'Memories': memText,
        'Canon': canonText,
        'Open Threads': arcText,
        'Scene': sceneText,
        'Current Time': timeText,
        'Chat History': history.map(m => `${m.name}: ${m.text}`).join('\n'),
    };

    // Context cap: drop oldest history lines until the prompt fits.
    const roomCtx = db.prepare('SELECT max_context FROM rooms WHERE rooms_id_pk=?').get(roomId)?.max_context || 0;
    const caps = [roomCtx, conn.context_size || 0].filter(v => v > 0);
    const maxCtx = caps.length ? Math.min(...caps) : 0;
    if (maxCtx > 0) {
        const overhead = Object.entries(parts).filter(([k]) => k !== 'Chat History')
            .reduce((a, [, v]) => a + v, 0);
        let histTok = parts['Chat History'];
        const histStart = histTok;
        const dropped = [];
        // ST-style: keep the opening message (greeting anchors the scene),
        // trim the middle, keep the recent tail.
        while (history.length > 2 && overhead + histTok > maxCtx) {
            const m = history.splice(1, 1)[0];
            histTok -= tok(m.name + ' ' + m.text);
            dropped.push(`${m.name}: ${m.text}`);
        }
        parts['Chat History'] = histTok;
        parts['(capped)'] = maxCtx;
        if (dropped.length) {
            parts['(cut from history)'] = histStart - histTok;
            texts['(cut from history)'] = dropped.join('\n\n');
        }
    }

    const reqBody = {
        model: conn.model || 'local',
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            // The card's own past lines are its voice (assistant);
            // everyone else's lines are tagged context (user).
            ...history.map(m => m.cards_id_fk === card.id
                ? { role: 'assistant', content: m.text }
                : { role: 'user', content: `${m.name}: ${m.text}` }),
            // Blocks ordered below 'history' land here — recent context the
            // model reads right before replying.
            ...(postSys ? [{ role: 'system', content: postSys }] : []),
            // Final nudge — primes the model to continue as this character.
            { role: 'user', content: `${card.name}:` },
        ],
        temperature: 0.8,
        max_tokens: conn.max_response || 2048,
    };
    const resp = await llmFetch(conn, reqBody);
    if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) { console.log('[gen] empty — raw:', JSON.stringify(data).slice(0, 600)); throw new Error('empty AI response'); }
    genStats[roomId] = {
        at: Date.now(), card: card.name,
        est: Object.entries(parts).filter(([k]) => !k.startsWith('(')).reduce((a, [, b]) => a + b, 0),
        prompt_tokens: data?.usage?.prompt_tokens ?? null,
        completion_tokens: data?.usage?.completion_tokens ?? null,
        parts,
        texts,
        request: reqBody,
    };
    logPrompt(roomId, card.id, 'reply', reqBody, text, data?.usage);
    // Always drop a leading "Name:" / "**Name:**" / "[Name]" speaker tag —
    // the UI already labels messages; the tag only exists for steering.
    {
        const esc = card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^\\**\\[?${esc}\\]?\\**\\s*:\\s*`, 'i'), '').trimStart();
    }
    if (refreshN > 1) db.prepare('UPDATE rooms SET mem_refresh_count=? WHERE rooms_id_pk=?').run(refreshKey + 1, roomId);
    return text;
}
