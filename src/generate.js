import { db, activeProfile, MSG_SQL } from './db.js';
import { push } from './lib/sse.js';

// Latest prompt composition per room — exposed for the chat sidebar.
export const genStats = {};

// Persist each LLM call for later inspection — genStats only keeps the last
// request in memory, and prod has no DB access. Newest 50 rows per room.
function logPrompt(roomId, cardId, kind, reqBody, text, usage) {
    db.prepare('INSERT INTO prompt_logs (rooms_id_fk,cards_id_fk,kind,request,response,prompt_tokens,completion_tokens) VALUES (?,?,?,?,?,?,?)')
        .run(roomId, cardId, kind, JSON.stringify(reqBody), text || '', usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null);
    db.prepare('DELETE FROM prompt_logs WHERE rooms_id_fk=? AND prompt_logs_id_pk NOT IN (SELECT prompt_logs_id_pk FROM prompt_logs WHERE rooms_id_fk=? ORDER BY prompt_logs_id_pk DESC LIMIT 50)')
        .run(roomId, roomId);
}
const tok = s => Math.ceil((s || '').length / 4); // rough chars/4 estimate

// Built-in extraction prompt, used when a profile leaves its template
// blank. The triggers suffix is appended only to the built-in prompt.
export const MEM_EXTRACT_PROMPT = `You extract lasting memories from roleplay chat logs. All memories are shared with the whole chat.
Character sheets included in the input are the AUTHORITATIVE current state for each character — trust them over older chat claims. If the excerpt shows a character's state changing (something fixed, removed, acquired, moved), record the NEW state, not the old.
System lines — "Ruling: …" decisions and "… rolls … → N" dice results — are authoritative outcomes, never contested. When participants disagree about what is true, the most recent message wins.
Output exactly ONE bullet point — the single most important lasting memory from this excerpt. "- " prefix, one line, starting with exactly one type tag — pick the most specific that fits:
- [event] — something that HAPPENED and is DONE: a self-contained action or beat, closed the moment it occurs. "Karima opened the fridge" is an event — nothing stays pending afterward.
- [relationship] — how characters FEEL about each other or a thing. "Ellie adores teasing SirRackington" is a relationship.
- [preference] — a like/dislike/want. "Blake hates green" is a preference.
- [fact] — LAST RESORT: only static truths that aren't events, feelings or preferences — identity, possessions, rules, ongoing states. "SirRackington is a server rack" is a fact.
Do NOT default to [fact] — if the memory describes something that occurred or a feeling, it is NOT a fact. Write a complete sentence that names the subject — no pronouns, no narration.
Example input: "Blake: the Venice API review pile is killing me\\nCreamms: I'll take half of it tomorrow"
Example output:
- [event] Creamms offered to take half of Blake's review pile tomorrow.`;
const MEM_TRIGGERS_SUFFIX = ' For each memory also append its trigger keywords in parentheses — the words most likely to re-evoke it, including synonyms, titles, and roles, e.g. "- [fact] The king is dead. (triggers: king, monarch, crown, throne)"';
// Arc-tracking addendum for the built-in extraction prompt, appended when the
// profile tracks arcs (mem_max_arcs > 0). Arc lines may appear alongside the
// single memory bullet; [arc] advances and [arc-close] resolves a thread.
// The core teaching is event-vs-thread: a memory is history, a thread is an
// unresolved situation that stays open until something settles it.
const MEM_ARCS_SUFFIX = ` Threads: a thread is NOT a memory — it is an open situation left pending until it resolves: a debt owed, a repair in progress, an investigation, a brewing conflict, a promise awaiting fulfilment. If the excerpt opens, advances, or resolves one, additionally output "- [arc-open] Title — what is underway", "- [arc] Title — the new development", or "- [arc-close] Title — how it settled". Reuse an open thread's title exactly when updating or closing it. The test: an event is closed when it happens ("Buddy broke the wheel" is [event]); a thread needs a resolution ("the wheel must be replaced before inspection" is a thread). Transient states — injuries, sanctions, pending fixes, ongoing suspicions — belong to threads, never [fact]: arcs close; facts linger as stale truth.`;

// Scene-state snapshot prompt — a dedicated pass that answers "what is true
// right now" (locations, held objects, ongoing conditions). The model emits
// a keyed JSON set — one entry per subject — and the script owns the diff:
// a subject's new value supersedes its old one, subjects absent from the set
// are retracted. Unlike extracted memories it is not cumulative.
export const MEM_STATE_PROMPT = `You track the current scene state of a roleplay chat as a keyed set. From the latest messages (and the previous set, if one is shown), describe what is true RIGHT NOW: where each person is, where important objects are and who holds them, ongoing activities or conditions. Output a single JSON object mapping each subject to its current state, e.g. {"Wren":"in the kitchen","blue tin":"on the counter","common room fire":"burned low"}.
Rules: exactly one entry per subject — the value IS the current truth and replaces whatever was true before. Carry unchanged subjects forward with their exact keys so the diff stays clean. Snapshot, not history — no events, no past states. System lines — "Ruling: …" decisions and "… rolls … → N" dice results — are authoritative outcomes. When participants disagree about what is true, the most recent message wins. If nothing is trackable, reply {}. Output only the JSON object, no prose.`;

// Fields a memory profile can override on a room's mem_* settings.
const MEM_PROFILE_FIELDS = ['mem_every', 'mem_budget', 'mem_max', 'mem_max_fact',
    'mem_max_event', 'mem_max_relationship', 'mem_max_preference', 'mem_extraction_prompt',
    'mem_context_threshold', 'mem_response_length', 'mem_gen_budget', 'mem_unlimited',
    'mem_unified', 'mem_triggers', 'mem_autotune', 'mem_refresh', 'mem_activity',
    'extraction_api_profiles_id_fk', 'mem_canon_budget', 'mem_max_arcs', 'mem_arc_budget',
    'arc_api_profiles_id_fk', 'mem_state', 'mem_state_every', 'mem_max_state',
    'mem_state_budget', 'mem_state_prompt'];

// Named system-prompt sections in cache-optimal order (stable content first —
// see the assembly comment in generateReply). The user's active
// prompt_profiles row can reorder them via prompt_order (JSON array of
// keys); NULL means this order. 'history' is a position marker, not text.
export const PROMPT_BLOCKS = [
    { key: 'main', label: 'Main prompt',
        example: 'You are Aria.' },
    { key: 'description', label: 'Card description',
        example: 'Description:\nAria is a wandering cartographer with a stolen map case.' },
    { key: 'personality', label: 'Card personality',
        example: 'Personality:\ncurious, blunt, secretly kind' },
    { key: 'scenario', label: 'Scenario',
        example: 'Scenario:\nThe party camps at the edge of the drowned forest.' },
    { key: 'examples', label: 'Example dialogue',
        example: 'Example dialogue:\nAria: We were never here.\n{{user}}: Says who?' },
    { key: 'roster', label: 'Other characters',
        example: 'Also present in the scene:\nBlake: a retired knight who owes Aria money' },
    { key: 'canon', label: 'Canon',
        example: 'Canon:\n- The drowned forest was destroyed in the war.' },
    { key: 'world', label: 'World info',
        example: 'World info:\nThe drowned forest floods every new moon.' },
    { key: 'memories', label: 'Memories',
        example: 'Memories:\n- [fact] Aria distrusts the harbor guild.\n- [event] Blake offered to carry the map case.' },
    { key: 'arcs', label: 'Open threads',
        example: 'Open threads:\n- The stolen map — Aria suspects the harbor guild took it' },
    { key: 'scene', label: 'Scene state',
        example: 'Scene:\n- Aria holds the stolen map.\n- The common room fire has burned low.' },
    { key: 'instructions', label: 'Instructions',
        example: "You are Aria and ONLY Aria — an NPC in a shared roleplay. The other characters listed are separate people speaking for themselves; do NOT speak for them or imitate them. Write ONLY Aria's next message." },
    { key: 'history', label: 'Chat history',
        example: 'Alice: We should leave before dawn.\nAria: The tide says otherwise.' },
    { key: 'time', label: 'Current time',
        example: 'Current time: Friday 13 November 2026, 21:49. Last message: 3 minutes ago.' },
];

/** Effective memory settings for a room: always the memory profile it follows
 *  via mem_profiles_id_fk. No link → the room's own columns: smart memories
 *  are off. Room columns only carry per-room bits like the injection-refresh
 *  counter. Following a profile IS the enable switch (the old auto_mem
 *  flag was dropped). */
export function memProfileFor(room) {
    const p = room?.mem_profiles_id_fk
        ? db.prepare('SELECT * FROM mem_profiles WHERE mem_profiles_id_pk=?').get(room.mem_profiles_id_fk)
        : null;
    if (!p) return room;
    const out = { ...room };
    for (const k of MEM_PROFILE_FIELDS) if (k in p) out[k] = p[k];
    return out;
}

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
    const roomMems = cap(db.prepare(`SELECT m.content,${TRIG_SQL} FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND ${HAS_TRIG} AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk) ORDER BY m.memories_id_pk DESC`).all(roomId).reverse().filter(active), budget, 0);
    const mems = cap(db.prepare(`SELECT m.content,${TRIG_SQL} FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk JOIN memory_cards mc ON mc.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND mc.cards_id_fk=? AND ${HAS_TRIG} AND ${LIVE} ORDER BY m.memories_id_pk DESC`)
        .all(roomId, card.id).reverse().filter(active), budget, roomMems.reduce((a, r) => a + tok(r.content), 0));

    // Canon: memories with no trigger keywords are always-true — injected
    // every generation, bypassing the refresh counter, capped by their own
    // budget. Shared canon + this card's canon both apply.
    const canonRows = cap(db.prepare(`SELECT m.content FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NULL AND m.type!='state' AND ${LIVE} AND ${NO_TRIG} AND (NOT EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk)
            OR EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk AND mc.cards_id_fk=?))
        ORDER BY m.memories_id_pk`).all(roomId, card.id), mem?.mem_canon_budget ?? 800);
    const canonText = canonRows.length ? 'Canon:\n' + canonRows.map(m => '- ' + m.content).join('\n') : null;

    // Open story arcs: tracked threads the AI should keep advancing.
    const arcRows = cap(db.prepare(`SELECT title || CASE WHEN summary!='' THEN ' — ' || summary ELSE '' END AS content
        FROM room_arcs WHERE rooms_id_fk=? AND status='open' ORDER BY updated`).all(roomId), mem?.mem_arc_budget ?? 700);
    // Closed arcs are consolidated chapters: the headline injects when a
    // title word reappears in context OR a folded memory's trigger fires —
    // the detail pulls its chapter back up, and any matching details ride
    // under the headline as indented sub-lines.
    const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'my', 'his', 'her', 'our']);
    const folded = db.prepare(`SELECT m.content, m.room_arcs_id_fk AS arcId,${TRIG_SQL}
        FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.room_arcs_id_fk IS NOT NULL AND ${LIVE}`).all(roomId);
    const hitKids = folded.filter(active).reduce((m, c) => ((m[c.arcId] ||= []).push(c), m), {});
    const pastArcs = cap(db.prepare(`SELECT room_arcs_id_pk AS id, title, summary FROM room_arcs
        WHERE rooms_id_fk=? AND status!='open' AND summary!='' ORDER BY updated DESC`).all(roomId)
        .filter(a => hitKids[a.id]?.length
            || a.title.toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length > 2 && !STOP.has(w)).some(w => wordHit(scanText, w)))
        .map(a => ({ content: `- ${a.title} — ${a.summary}`
            + (hitKids[a.id] || []).map(c => `\n  - ${c.content}`).join('') })),
        mem?.mem_arc_budget ?? 700);
    const arcText = (arcRows.length || pastArcs.length)
        ? (arcRows.length ? 'Open threads:\n' + arcRows.map(a => '- ' + a.content).join('\n') : '')
            + (pastArcs.length ? (arcRows.length ? '\n\n' : '') + 'Earlier events:\n' + pastArcs.map(a => a.content).join('\n') : '')
        : null;

    // Scene state: the latest "what is true right now" snapshot — locations,
    // held objects, ongoing conditions. Always injected when present (it is
    // by definition relevant), never trigger-gated, own token budget.
    const sceneRows = cap(db.prepare(`SELECT m.content FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.type='state' AND m.room_arcs_id_fk IS NULL AND ${LIVE} ORDER BY m.memories_id_pk`).all(roomId),
        mem?.mem_state_budget ?? 400);
    const sceneText = sceneRows.length ? 'Scene:\n' + sceneRows.map(m => '- ' + m.content).join('\n') : null;

    const memText = (injectMem && (roomMems.length || mems.length))
        ? (mem?.mem_unified
            ? ['Memories:\n' + [...roomMems.map(m => '- ' + m.content), ...mems.map(m => '- ' + m.content)].join('\n')].join('')
            : [
                roomMems.length && 'What happened here:\n' + roomMems.map(m => '- ' + m.content).join('\n'),
                mems.length && `Things ${card.name} remembers:\n` + mems.map(m => '- ' + m.content).join('\n'),
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
    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
            ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })(),
        },
        body: JSON.stringify(reqBody),
    });
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

/**
 * Smart memories: ask the model to distill an excerpt into bullet facts,
 * stored as shared room memories. Runs after every N messages per room.
 */
export async function maybeSummarize(roomId) {
    const room = db.prepare('SELECT *, rooms_id_pk AS id FROM rooms WHERE rooms_id_pk=?').get(roomId);
    // Smart memories run when the room follows a memory profile — the picker
    // is the on/off switch (mem_profiles.auto_mem is deprecated; the
    // owner-owned extraction profile check below still gates).
    if (!room?.mem_profiles_id_fk) return;
    const mem = memProfileFor(room);
    const lastId = db.prepare('SELECT MAX(messages_id_pk) m FROM messages WHERE rooms_id_fk=?').get(roomId).m || 0;
    const interval = mem.mem_every || 10;
    const threshold = mem.mem_context_threshold || 80;
    const maxCtx = room.max_context || 6400;
    // Messages since last extraction.
    const since = db.prepare('SELECT text FROM messages WHERE rooms_id_fk=? AND messages_id_pk>?').all(roomId, room.mem_last_messages_id_fk);
    const sinceTokens = since.reduce((a, m) => a + tok(m.text), 0);
    const contextPct = maxCtx > 0 ? (sinceTokens / maxCtx) * 100 : 0;
    const intervalMet = lastId - room.mem_last_messages_id_fk >= interval;
    const thresholdMet = contextPct >= threshold;
    if (!intervalMet && !thresholdMet) return;
    // Memory extraction uses only the profile the room owner configured —
    // no fallback. Unset, missing, or owned by someone else: skip.
    const ext = mem.extraction_api_profiles_id_fk
        ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=?').get(mem.extraction_api_profiles_id_fk)
        : null;
    if (!ext?.api_url || ext.users_id_fk !== room.owner_users_id_fk) {
        if (mem.mem_activity) console.log(`[mem] activity: extraction skipped for room ${roomId} (no owner-configured extraction profile)`);
        return;
    }
    const conn = { ...ext, apiUrl: ext.api_url };
    const excerpt = db.prepare(
        MSG_SQL + ' WHERE m.rooms_id_fk=? AND m.messages_id_pk>? ORDER BY m.messages_id_pk LIMIT 30')
        .all(roomId, room.mem_last_messages_id_fk);
    if (!excerpt.length) return;
    if (mem.mem_activity) push(roomId, { type: 'mem', phase: 'start' });
    // Grounding: the cards in the room are the authoritative current state,
    // so extraction can record NEW states instead of re-asserting stale chat.
    const roster = db.prepare(`SELECT c.name, c.description FROM room_members rm
        JOIN cards c ON c.cards_id_pk=rm.cards_id_fk WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0`)
        .all(roomId);
    const sheet = roster.length
        ? 'Character sheets (authoritative current state):\n'
            + roster.map(c => `${c.name}: ${c.description || c.name}`).join('\n') + '\n\n'
        : '';
    // Open thread titles go into the prompt so the writer can advance or
    // close them by name instead of spawning near-duplicate threads.
    const openArcs = db.prepare("SELECT title FROM room_arcs WHERE rooms_id_fk=? AND status='open' ORDER BY updated").all(roomId).map(a => a.title);
    const arcsSuffix = (mem.mem_max_arcs ?? 10) > 0
        ? MEM_ARCS_SUFFIX + (openArcs.length ? ` Currently open threads: ${openArcs.join('; ')}.` : '')
        : '';
    // Supersede-eligible memories — smart, live, shared, non-state, unfolded —
    // listed with reference numbers so the writer can retire one by emitting
    // "- [supersede N] new fact". User memories are never offered: only the
    // system retracts what the system wrote.
    const supersedable = db.prepare(`SELECT m.memories_id_pk AS id, m.type, m.content FROM memories m
        JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type!='state' AND m.room_arcs_id_fk IS NULL
          AND m.superseded_by_memories_id_fk IS NULL
        ORDER BY m.memories_id_pk DESC LIMIT 30`).all(roomId).reverse();
    const supersedeSuffix = supersedable.length
        ? ' If the memory you write updates or contradicts a current memory, write it as "- [supersede N] …" where N is the number of the memory it replaces — the old memory is retired, never keep both.'
        : '';
    const memList = supersedable.length
        ? 'Current memories (numbered — a [supersede N] tag retires one):\n'
            + supersedable.map((m, i) => `${i + 1}) [${m.type}] ${m.content}`).join('\n') + '\n\n'
        : '';
    const reqBody = {
        model: conn.model || 'local',
        messages: [
            { role: 'system', content: mem.mem_extraction_prompt?.trim() || (MEM_EXTRACT_PROMPT + (mem.mem_triggers ? MEM_TRIGGERS_SUFFIX : '') + arcsSuffix + supersedeSuffix) },
            { role: 'user', content: sheet + memList + 'Recent chat:\n' + excerpt.map(m => `${m.name}: ${m.text}`).join('\n') },
        ],
        temperature: 0.3, max_tokens: mem.mem_unlimited ? -1 : (mem.mem_gen_budget || mem.mem_response_length || 2000),
    };
    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
            ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })() },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    logPrompt(roomId, null, 'extract', reqBody, text, data?.usage);
    let added = 0;
    const ins = db.prepare("INSERT INTO memories (content,type,origin) VALUES (?,?, 'smart')");
    const insTrig = db.prepare('INSERT OR IGNORE INTO memory_triggers (memories_id_fk,word) VALUES (?,?)');
    const linkRoom = db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)');
    const findArc = db.prepare("SELECT room_arcs_id_pk AS id FROM room_arcs WHERE rooms_id_fk=? AND status='open' AND LOWER(title)=LOWER(?)");
    const insArc = db.prepare("INSERT INTO room_arcs (rooms_id_fk,title,summary,opened_messages_id_fk,origin) VALUES (?,?,?,?,'smart')");
    const upArc = db.prepare("UPDATE room_arcs SET summary=?, status='open', updated=datetime('now') WHERE room_arcs_id_pk=?");
    const closeArc = db.prepare("UPDATE room_arcs SET status='resolved', closed_messages_id_fk=?, updated=datetime('now') WHERE room_arcs_id_pk=?");
    const closedArcs = [];
    for (const line of text.split('\n')) {
        let fact = line.replace(/^\s*[-*•]\s*/, '').trim();
        // Leading [tag]s: memory-type tags set the stored type, [arc*] tags
        // drive room_arcs, anything else ([Name]/[shared] scope tags) is
        // stripped. The old single-strip order silently flattened every
        // [event]/[preference]/[relationship] line to 'fact'.
        let type = 'fact', arc = null, supersedes = null;
        for (let i = 0; i < 4; i++) {
            const t = fact.match(/^\[([^\]]+)\]\s*/);
            if (!t) break;
            const w = t[1].trim().toLowerCase();
            if (['fact', 'event', 'relationship', 'preference'].includes(w)) type = w;
            else if (['arc', 'arc-open', 'arc-close'].includes(w)) arc = w;
            else if (/^supersedes?\s*[:#]?\s*\d+$/.test(w)) supersedes = parseInt(w.match(/\d+/)[0], 10);
            fact = fact.slice(t[0].length).trimStart();
        }
        if (arc) {
            const m = fact.match(/^(.*?)(?:\s+[—–]\s+|:\s+)(.*)$/s);
            const title = (m ? m[1] : fact).trim().replace(/[.\s]+$/, '');
            const summary = (m ? m[2] : '').trim();
            if (!title || (mem.mem_max_arcs ?? 10) <= 0) continue;
            const ex = findArc.get(roomId, title);
            if (arc === 'arc-close') { if (ex) { closeArc.run(lastId, ex.id); closedArcs.push(ex.id); } }
            else if (ex) { if (summary) upArc.run(summary, ex.id); }
            else insArc.run(roomId, title, summary, lastId);
            continue;
        }
        let triggers = '';
        // "(triggers: a, b)" anywhere in the line; else a bare trailing "(a, b)".
        const tr = fact.match(/\(\s*triggers?\s*:\s*([^)]*)\)/i) || fact.match(/\(([^)]*)\)\s*$/);
        if (tr) {
            triggers = tr[1].split(',').map(s => s.trim().replace(/^triggers?\s*:/i, '').toLowerCase()).filter(Boolean).join(',');
            fact = (fact.slice(0, tr.index) + fact.slice(tr.index + tr[0].length)).trim();
        }
        if (fact.length > 10 && !added) {
            const mid = ins.run(fact, type).lastInsertRowid;
            for (const w of triggers.split(',')) { const word = w.trim(); if (word) insTrig.run(mid, word); }
            linkRoom.run(roomId, mid); added++;
            // [supersede N]: the new memory retires list entry N — marked, not
            // deleted, so the audit trail survives (FK SET NULL revives the
            // original if the replacement is ever deleted).
            const target = supersedes && supersedable[supersedes - 1];
            if (target) db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?')
                .run(mid, target.id);
            // One memory per extraction run — but keep scanning the rest of
            // the output for [arc*] lines.
        }
    }
    // Only advance the watermark once extraction actually ran — a failed
    // call retries on the next message instead of silently skipping.
    db.prepare('UPDATE rooms SET mem_last_messages_id_fk=?, mem_extract_count=mem_extract_count+1 WHERE rooms_id_pk=?').run(lastId, roomId);
    // Scene-state snapshot rides the extraction connection and cadence —
    // every mem_state_every extraction runs it rewrites "what is true now".
    if (mem.mem_state) await maybeUpdateState(roomId, mem, conn);
    if (mem.mem_activity) {
        console.log(`[mem] activity: extraction ran for room ${roomId} (${intervalMet ? 'interval' : 'context threshold'})`);
    }
    // Always signal completion — clients refresh lastmem on done even when
    // activity notifications (the flash) are disabled.
    push(roomId, { type: 'mem', phase: 'done', count: added, notify: !!mem.mem_activity });
    // Cap stored smart memories per type — oldest entries of each type drop off.
    // Superseded rows don't occupy cap slots (they're already retracted).
    for (const [type, col] of [['fact','mem_max_fact'],['event','mem_max_event'],['relationship','mem_max_relationship'],['preference','mem_max_preference']]) {
        const cap = mem[col] || 0;
        if (cap <= 0) continue;
        db.prepare(`DELETE FROM memories WHERE origin='smart' AND type=? AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type=? AND m.superseded_by_memories_id_fk IS NULL
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' AND m2.type=? AND m2.superseded_by_memories_id_fk IS NULL ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(type, roomId, type, roomId, type, cap);
    }
    // Global cap (mem_max) as a safety net across all types.
    const totalCap = mem.mem_max || 0;
    if (totalCap > 0) {
        db.prepare(`DELETE FROM memories WHERE origin='smart' AND type!='state' AND superseded_by_memories_id_fk IS NULL AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type!='state' AND m.superseded_by_memories_id_fk IS NULL
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' AND m2.type!='state' AND m2.superseded_by_memories_id_fk IS NULL ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(roomId, roomId, totalCap);
    }
    // Cap open arcs — oldest-touched threads are dropped first.
    const arcMax = mem.mem_max_arcs ?? 10;
    if (arcMax > 0) {
        closedArcs.push(...db.prepare(`SELECT room_arcs_id_pk AS id FROM room_arcs WHERE rooms_id_fk=? AND status='open'
            AND room_arcs_id_pk NOT IN (SELECT room_arcs_id_pk FROM room_arcs WHERE rooms_id_fk=? AND status='open' ORDER BY updated DESC LIMIT ?)`)
            .all(roomId, roomId, arcMax).map(r => r.id));
        db.prepare(`UPDATE room_arcs SET status='dropped', updated=datetime('now') WHERE rooms_id_fk=? AND status='open'
            AND room_arcs_id_pk NOT IN (SELECT room_arcs_id_pk FROM room_arcs WHERE rooms_id_fk=? AND status='open' ORDER BY updated DESC LIMIT ?)`)
            .run(roomId, roomId, arcMax);
    }
    // Consolidate every thread that closed this run — spans include this
    // batch's memories, so folding has to happen after all inserts.
    for (const id of closedArcs) consolidateArc(roomId, id).catch(e => console.error('[mem]', e.message));
    // Auto-tune: when enabled, raise the injection budget so stored smart
    // memories aren't dropped purely for exceeding the current budget.
    // (Budgets live on the memory profile now — rooms only carry the FK.)
    if (mem.mem_autotune && mem.mem_profiles_id_pk) {
        const used = db.prepare(`SELECT COALESCE(SUM(LENGTH(m.content)/4.0),0) AS s FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.superseded_by_memories_id_fk IS NULL`).get(roomId)?.s || 0;
        const b = mem.mem_budget || 800;
        if (used > b && b < 8000) db.prepare('UPDATE mem_profiles SET mem_budget=? WHERE mem_profiles_id_pk=?').run(Math.ceil(used), mem.mem_profiles_id_pk);
    }
}

// Scene-state snapshot — answers "what is true right now" (locations, held
// objects, ongoing conditions) as a keyed JSON set: one entry per subject.
// The script owns the diff — a subject's new value supersedes its old row in
// place, subjects absent from the set are retracted, unchanged entries keep
// their rows. Contradictory states can't stack: a subject has exactly one
// current value. Runs on the extraction connection every mem_state_every
// extraction runs; state rows are room-shared, carry no triggers (always
// relevant → always injected), and skip arc folding.
async function maybeUpdateState(roomId, mem, conn) {
    const room = db.prepare('SELECT mem_extract_count FROM rooms WHERE rooms_id_pk=?').get(roomId);
    const every = Math.max(1, mem.mem_state_every || 1);
    if ((room.mem_extract_count || 0) % every !== 0) return;
    // State describes NOW — take the tail of the conversation, not the
    // extraction watermark window.
    const excerpt = db.prepare(MSG_SQL + ' WHERE m.rooms_id_fk=? ORDER BY m.messages_id_pk DESC LIMIT 30')
        .all(roomId).reverse();
    if (!excerpt.length) return;
    // The live set, keyed by subject — shown to the model so unchanged
    // subjects keep their exact keys (a renamed key diffs as retract+insert).
    const rows = db.prepare(`SELECT m.memories_id_pk AS id, m.state_key, m.content FROM memories m
        JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.type='state' AND m.origin='smart'
        AND m.superseded_by_memories_id_fk IS NULL ORDER BY m.memories_id_pk`).all(roomId);
    const prev = rows.length ? 'Current set:\n' + rows.map(r => '- ' + r.content).join('\n') + '\n\n' : '';
    const reqBody = {
        model: conn.model || 'local',
        messages: [
            { role: 'system', content: mem.mem_state_prompt?.trim() || MEM_STATE_PROMPT },
            { role: 'user', content: prev + 'Recent chat:\n' + excerpt.map(m => `${m.name}: ${m.text}`).join('\n') },
        ],
        temperature: 0.2, max_tokens: mem.mem_unlimited ? -1 : (mem.mem_gen_budget || mem.mem_response_length || 2000),
    };
    try {
        const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
                ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })() },
            body: JSON.stringify(reqBody),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim() || '';
        logPrompt(roomId, null, 'state', reqBody, text, data?.usage);
        // The set string: one JSON object, subject → current state. Grab the
        // first {...} span — models wrap output in prose/fences. Non-string
        // values are coerced except objects (a nested state is a misfire).
        let set = null;
        const j = text.match(/\{[\s\S]*\}/);
        if (j) {
            try {
                const o = JSON.parse(j[0]);
                if (o && typeof o === 'object' && !Array.isArray(o)) {
                    set = new Map();
                    for (const [k, v] of Object.entries(o)) {
                        const key = k.trim(), val = String(v ?? '').trim();
                        if (key && val && (typeof v !== 'object' || v === null)) set.set(key, val);
                    }
                }
            } catch { /* unparseable — keep the last good snapshot */ }
        }
        if (!set?.size) return;
        const cap = Math.max(0, mem.mem_max_state ?? 30);
        const entries = cap > 0 ? [...set.entries()].slice(0, cap) : [];
        db.exec('BEGIN');
        try {
            // History is kept: a changed value gets a fresh row and the old
            // one points at it via superseded_by; a dropped key is tombstoned
            // (superseded_by = self — retracted, no successor). "Current" is
            // always exactly the live row per subject — no latest-version
            // ambiguity for injection or UI.
            const byKey = new Map(rows.map(r => [r.state_key?.toLowerCase(), r]));
            const seen = new Set();
            const ins = db.prepare("INSERT INTO memories (content,type,origin,state_key) VALUES (?, 'state', 'smart', ?)");
            const linkRoom = db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)');
            const sup = db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?');
            for (const [subject, val] of entries) {
                const content = `${subject} — ${val}`;
                const ex = byKey.get(subject.toLowerCase());
                if (!ex) { linkRoom.run(roomId, ins.run(content, subject).lastInsertRowid); continue; }
                seen.add(ex.id);
                if (ex.content === content) continue;
                const nid = ins.run(content, subject).lastInsertRowid;
                linkRoom.run(roomId, nid);
                sup.run(nid, ex.id);
            }
            const tomb = db.prepare('UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk WHERE memories_id_pk=?');
            for (const r of rows) if (!seen.has(r.id)) tomb.run(r.id);
            db.exec('COMMIT');
            if (mem.mem_activity) console.log(`[mem] activity: state snapshot refreshed for room ${roomId} (${entries.length} entries)`);
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    } catch (e) {
        if (mem.mem_activity) console.log(`[mem] activity: state snapshot failed for room ${roomId} (${e.message})`);
    }
}

// Arc consolidation: when a thread closes, distill its message span into
// the arc's summary — the chapter headline — and fold the smart memories
// extracted during the span under it. Folded memories stop injecting on
// their own; their triggers now pull the arc line into context instead,
// and any that match are appended as detail under the headline (submemory
// retrieval). Untriggered (canon) memories are never folded — durable
// facts stay top-level. Uses the profile's arc API profile, falling back
// to the extraction profile; neither configured = consolidation off.
export async function consolidateArc(roomId, arcId) {
    const arc = db.prepare('SELECT * FROM room_arcs WHERE room_arcs_id_pk=?').get(arcId);
    if (!arc || arc.status === 'open') return;
    const room = db.prepare('SELECT * FROM rooms WHERE rooms_id_pk=?').get(roomId);
    const mem = memProfileFor(room);
    if (!mem) return;
    const pid = mem.arc_api_profiles_id_fk || mem.extraction_api_profiles_id_fk;
    const ext = pid ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=?').get(pid) : null;
    if (!ext?.api_url || ext.users_id_fk !== room.owner_users_id_fk) return;
    const conn = { ...ext, apiUrl: ext.api_url };

    // Span: between the open/close message anchors when present, else the
    // arc's creation time / the latest room message.
    const dateOf = id => id ? db.prepare('SELECT send_date AS d FROM messages WHERE messages_id_pk=?').get(id)?.d : null;
    const spanStart = dateOf(arc.opened_messages_id_fk) || arc.created;
    const lastMsgId = db.prepare('SELECT MAX(messages_id_pk) AS m FROM messages WHERE rooms_id_fk=?').get(roomId).m || 0;
    const span = db.prepare(MSG_SQL + ' WHERE m.rooms_id_fk=? AND m.messages_id_pk BETWEEN ? AND ? ORDER BY m.messages_id_pk')
        .all(roomId, arc.opened_messages_id_fk || 0, arc.closed_messages_id_fk || lastMsgId);
    if (span.length) {
        // Long spans: head (setup) + tail (resolution) matter most.
        let text = span.map(m => `${m.name}: ${m.text}`).join('\n');
        if (text.length > 8000) text = text.slice(0, 3000) + '\n[…]\n' + text.slice(-5000);
        const reqBody = {
            model: conn.model || 'local',
            messages: [
                { role: 'system', content: 'You are the chronicler of a roleplay story. Given a story thread and the chat excerpt it played out in, write a ONE to TWO sentence past-tense summary of what happened and how it ended. Factual and compact — names and outcomes, no flourish.' },
                { role: 'user', content: `Thread: ${arc.title}${arc.summary ? '\nNotes: ' + arc.summary : ''}\n\nExcerpt:\n${text}` },
            ],
            temperature: 0.3, max_tokens: 300,
        };
        const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
                ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })() },
            body: JSON.stringify(reqBody),
        });
        if (resp.ok) {
            const summary = (await resp.json())?.choices?.[0]?.message?.content?.trim();
            if (summary) {
                db.prepare("UPDATE room_arcs SET summary=?, updated=datetime('now') WHERE room_arcs_id_pk=?").run(summary, arcId);
                logPrompt(roomId, null, 'extract', reqBody, summary, null);
            }
        }
    }
    // Fold smart, triggered memories created since the arc opened under
    // it. (No upper bound: consolidation runs once, at close — memory
    // timestamps are extraction-time, so they always postdate the close
    // anchor's send_date.)
    db.prepare(`UPDATE memories SET room_arcs_id_fk=? WHERE origin='smart' AND room_arcs_id_fk IS NULL
        AND superseded_by_memories_id_fk IS NULL
        AND created >= ?
        AND memories_id_pk IN (SELECT memories_id_fk FROM room_memories WHERE rooms_id_fk=?)
        AND EXISTS (SELECT 1 FROM memory_triggers mt WHERE mt.memories_id_fk=memories.memories_id_pk)`)
        .run(arcId, spanStart, roomId);
}
