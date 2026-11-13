import { db, activeProfile, MSG_SQL } from './db.js';
import { push } from './sse.js';

// Latest prompt composition per room — exposed for the chat sidebar.
export const genStats = {};
const tok = s => Math.ceil((s || '').length / 4); // rough chars/4 estimate

// Fields a memory profile can override on a room's mem_* settings.
const MEM_PROFILE_FIELDS = ['auto_mem', 'mem_every', 'mem_budget', 'mem_max', 'mem_max_fact',
    'mem_max_event', 'mem_max_relationship', 'mem_max_preference', 'mem_extraction_prompt',
    'mem_context_threshold', 'mem_response_length', 'mem_gen_budget', 'mem_unlimited',
    'mem_unified', 'mem_triggers', 'mem_autotune', 'mem_refresh', 'mem_activity',
    'mem_extraction_profile_id'];

/** Effective memory settings for a room: always the memory profile it follows
 *  (falling back to the first profile when none is assigned) — there is no
 *  per-chat custom option. Room columns only carry per-room bits like
 *  the injection-refresh counter. */
export function memProfileFor(room) {
    const p = db.prepare(`SELECT * FROM mem_profiles WHERE mem_profiles_id_pk=COALESCE(?,(SELECT mem_profiles_id_pk FROM mem_profiles ORDER BY mem_profiles_id_pk LIMIT 1))`)
        .get(room?.mem_profiles_id_fk || null);
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
    const others = db.prepare(`SELECT c.name, c.description FROM room_members rm JOIN members m ON m.members_id_pk=rm.members_id_fk
        JOIN cards c ON c.cards_id_pk=m.cards_id_fk WHERE rm.rooms_id_fk=? AND IFNULL(c.is_persona,0)=0 AND c.cards_id_pk!=?`)
        .all(roomId, card.id);

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
            return prim.some(k => k && scanText.includes(k.toLowerCase()))
                && sec.every(k => !k || scanText.includes(k.toLowerCase()));
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
    const cap = (rows, acc) => { let used = acc; return rows.filter(r => (used += tok(r.content)) <= budget); };
    const recentText = history.slice(-3).map(m => m.text).join(' ').toLowerCase();
    const active = r => !r.triggers || r.triggers.split(/[\s,]+/).filter(Boolean)
        .some(t => recentText.includes(t.toLowerCase()));
    const roomMems = cap(db.prepare('SELECT m.content,m.triggers FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND NOT EXISTS (SELECT 1 FROM memory_cards mc WHERE mc.memories_id_fk=m.memories_id_pk) ORDER BY m.memories_id_pk DESC').all(roomId).reverse().filter(active), 0);
    const mems = cap(db.prepare('SELECT m.content,m.triggers FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk JOIN memory_cards mc ON mc.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND mc.cards_id_fk=? ORDER BY m.memories_id_pk DESC')
        .all(roomId, card.id).reverse().filter(active), roomMems.reduce((a, r) => a + tok(r.content), 0));

    const memText = (injectMem && (roomMems.length || mems.length))
        ? (mem?.mem_unified
            ? ['Memories:\n' + [...roomMems.map(m => '- ' + m.content), ...mems.map(m => '- ' + m.content)].join('\n')].join('')
            : [
                roomMems.length && 'What happened here:\n' + roomMems.map(m => '- ' + m.content).join('\n'),
                mems.length && `Things ${card.name} remembers:\n` + mems.map(m => '- ' + m.content).join('\n'),
            ].filter(Boolean).join('\n\n'))
        : null;

    const system = [
        card.system_prompt || `You are ${card.name}.`,
        worldText,
        memText,
        card.description && `Description:\n${card.description}`,
        card.personality && `Personality:\n${card.personality}`,
        card.scenario && `Scenario:\n${card.scenario}`,
        card.mes_example && `Example dialogue:\n${card.mes_example}`,
        others.length && `Also present in the scene:\n` +
            others.map(o => `${o.name}: ${o.description || o.name}`).join('\n'),
        `You are ${card.name} and ONLY ${card.name} — an NPC in a shared roleplay. ` +
            `The other characters listed are separate people speaking for themselves; ` +
            `do NOT speak for them or imitate them. Write ONLY ${card.name}'s next message.` +
            (card.post_history_instructions ? ` ${card.post_history_instructions}` : ''),
    ].filter(Boolean).join('\n\n');

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
            { role: 'system', content: system },
            // The card's own past lines are its voice (assistant);
            // everyone else's lines are tagged context (user).
            ...history.map(m => m.cards_id_fk === card.id
                ? { role: 'assistant', content: m.text }
                : { role: 'user', content: `${m.name}: ${m.text}` }),
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
    const mem = memProfileFor(room);
    if (!mem?.auto_mem) return;
    const lastId = db.prepare('SELECT MAX(messages_id_pk) m FROM messages WHERE rooms_id_fk=?').get(roomId).m || 0;
    const interval = mem.mem_every || 10;
    const threshold = mem.mem_context_threshold || 80;
    const maxCtx = room.max_context || 6400;
    // Messages since last extraction.
    const since = db.prepare('SELECT text FROM messages WHERE rooms_id_fk=? AND messages_id_pk>?').all(roomId, room.mem_last_messages_id);
    const sinceTokens = since.reduce((a, m) => a + tok(m.text), 0);
    const contextPct = maxCtx > 0 ? (sinceTokens / maxCtx) * 100 : 0;
    const intervalMet = lastId - room.mem_last_messages_id >= interval;
    const thresholdMet = contextPct >= threshold;
    if (!intervalMet && !thresholdMet) return;
    // Memory extraction uses only the profile the room owner configured —
    // no fallback. Unset, missing, or owned by someone else: skip.
    const ext = mem.mem_extraction_profile_id
        ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=?').get(mem.mem_extraction_profile_id)
        : null;
    if (!ext?.api_url || ext.users_id_fk !== room.owner_users_id_fk) {
        if (mem.mem_activity) console.log(`[mem] activity: extraction skipped for room ${roomId} (no owner-configured extraction profile)`);
        return;
    }
    const conn = { ...ext, apiUrl: ext.api_url };
    const excerpt = db.prepare(
        MSG_SQL + ' WHERE m.rooms_id_fk=? AND m.messages_id_pk>? ORDER BY m.messages_id_pk LIMIT 30')
        .all(roomId, room.mem_last_messages_id);
    if (!excerpt.length) return;
    if (mem.mem_activity) push(roomId, { type: 'mem', phase: 'start' });
    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
            ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })() },
        body: JSON.stringify({
            model: conn.model || 'local',
            messages: [
                { role: 'system', content: mem.mem_extraction_prompt?.trim() || `You extract lasting facts from roleplay logs. Output ONLY bullet points (one per line, "- " prefix). Each bullet must be a complete, self-contained sentence that names its subject (e.g. "Blake has a pending review pile for API configurations including Venice API."). Start with a type tag [fact], [event], [relationship] or [preference]. Use [shared] only for room-wide facts, and include the subject in the sentence. No narration, no pronouns without a named subject.${mem.mem_triggers ? ' For each memory also append its trigger keywords in parentheses, e.g. "- [fact] Blake has a pending review pile. (triggers: pending, review)"' : ''}` },
                { role: 'user', content: excerpt.map(m => `${m.name}: ${m.text}`).join('\n') },
            ],
            temperature: 0.3, max_tokens: mem.mem_unlimited ? -1 : (mem.mem_gen_budget || mem.mem_response_length || 2000),
        }),
    });
    if (!resp.ok) return;
    const text = (await resp.json())?.choices?.[0]?.message?.content?.trim() || '';
    let added = 0;
    const ins = db.prepare("INSERT INTO memories (content,type,origin,triggers) VALUES (?,?, 'smart', ?)");
    const linkRoom = db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)');
    for (const line of text.split('\n')) {
        let fact = line.replace(/^\s*[-*•]\s*/, '').trim();
        fact = fact.replace(/^\[[^\]]+\]\s*/, ''); // strip leading [Name]/[shared] scope tag
        const tag = fact.match(/^\[(fact|event|relationship|preference)\]\s*/i);
        const type = tag ? tag[1].toLowerCase() : 'fact';
        if (tag) fact = fact.slice(tag[0].length);
        let triggers = '';
        const tr = fact.match(/\(([^)]*)\)\s*$/);
        if (tr) { triggers = tr[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean).join(','); fact = fact.slice(0, tr.index).trim(); }
        if (fact.length > 10) { const mid = ins.run(fact, type, triggers).lastInsertRowid; linkRoom.run(roomId, mid); added++; }
    }
    // Only advance the watermark once extraction actually ran — a failed
    // call retries on the next message instead of silently skipping.
    db.prepare('UPDATE rooms SET mem_last_messages_id=? WHERE rooms_id_pk=?').run(lastId, roomId);
    if (mem.mem_activity) {
        console.log(`[mem] activity: extraction ran for room ${roomId} (${intervalMet ? 'interval' : 'context threshold'})`);
        push(roomId, { type: 'mem', phase: 'done', count: added });
    }
    // Cap stored smart memories per type — oldest entries of each type drop off.
    for (const [type, col] of [['fact','mem_max_fact'],['event','mem_max_event'],['relationship','mem_max_relationship'],['preference','mem_max_preference']]) {
        const cap = mem[col] || 0;
        if (cap <= 0) continue;
        db.prepare(`DELETE FROM memories WHERE origin='smart' AND type=? AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type=?
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' AND m2.type=? ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(type, roomId, type, roomId, type, cap);
    }
    // Global cap (mem_max) as a safety net across all types.
    const totalCap = mem.mem_max || 0;
    if (totalCap > 0) {
        db.prepare(`DELETE FROM memories WHERE origin='smart' AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart'
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(roomId, roomId, totalCap);
    }
    // Auto-tune: when enabled, raise the injection budget so stored smart
    // memories aren't dropped purely for exceeding the current budget.
    // (Budgets live on the memory profile now — rooms only carry the FK.)
    if (mem.mem_autotune && mem.mem_profiles_id_pk) {
        const used = db.prepare(`SELECT COALESCE(SUM(LENGTH(m.content)/4.0),0) AS s FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk WHERE rm.rooms_id_fk=? AND m.origin='smart'`).get(roomId)?.s || 0;
        const b = mem.mem_budget || 800;
        if (used > b && b < 8000) db.prepare('UPDATE mem_profiles SET mem_budget=? WHERE mem_profiles_id_pk=?').run(Math.ceil(used), mem.mem_profiles_id_pk);
    }
}
