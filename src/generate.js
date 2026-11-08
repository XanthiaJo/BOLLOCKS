import { db, activeProfile, MSG_SQL } from './db.js';

// Latest prompt composition per room — exposed for the chat sidebar.
export const genStats = {};
const tok = s => Math.ceil((s || '').length / 4); // rough chars/4 estimate

/**
 * Server-side generation — the server owns the prompt AND the API call.
 * Prompt = card description (system) + recent messages (context). The API
 * config lives in the room owner's settings (user.settings JSON:
 * { apiUrl, model, key }) — read from DB, never reaches clients.
 */
export async function generateReply(roomId, card) {
    const owner = db.prepare(`SELECT u.users_id_pk FROM members m JOIN users u ON u.users_id_pk=m.users_id_fk
        WHERE m.rooms_id_fk=? AND m.kind='human' ORDER BY m.users_id_fk LIMIT 1`).get(roomId);
    // Card's own profile wins; otherwise the room owner's active profile.
    const p = card.api_profiles_id_fk
        ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE users_id_pk=?').get(card.api_profiles_id_fk)
        : null;
    const conn = p ? { ...p, apiUrl: p.api_url } : activeProfile(owner?.id);
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
    const others = db.prepare(`SELECT c.name, c.description FROM members m
        JOIN cards c ON c.cards_id_pk=m.cards_id_fk WHERE m.rooms_id_fk=? AND m.kind='ai' AND c.cards_id_pk!=?`)
        .all(roomId, card.id);

    // Keyword-triggered world entries: constant entries always in; keyed
    // entries fire when a key appears in recent chat or the card's fields.
    const scanText = (history.map(m => `${m.name} ${m.text}`).join('\n')
        + ' ' + (card.name || '') + ' ' + (card.description || '')).toLowerCase();
    const world = db.prepare(`SELECT e.* FROM world_entries e
        JOIN room_books rb ON rb.world_books_id_fk=e.world_books_id_fk
        WHERE rb.rooms_id_fk=? AND e.enabled=1 ORDER BY e.ord,e.world_entries_id_pk`).all(roomId)
        .filter(e => e.constant || (
            JSON.parse(e.keys || '[]').some(k => k && scanText.includes(k.toLowerCase()))
            && JSON.parse(e.keysecondary || '[]').every(k => !k || scanText.includes(k.toLowerCase()))));
    const worldText = world.length
        ? 'World info:\n' + world.map(e => e.content).join('\n\n')
        : null;

    // Long-term memories: shared room facts + this character's own.
    // Capped at the room's injection token budget (chars/4 estimate).
    const budget = db.prepare('SELECT mem_budget FROM rooms WHERE rooms_id_pk=?').get(roomId)?.mem_budget ?? 500;
    const cap = (rows, acc) => { let used = acc; return rows.filter(r => (used += tok(r.content)) <= budget); };
    const recentText = history.slice(-3).map(m => m.text).join(' ').toLowerCase();
    const active = r => !r.triggers || r.triggers.split(/[\s,]+/).filter(Boolean)
        .some(t => recentText.includes(t.toLowerCase()));
    const roomMems = cap(db.prepare('SELECT content,triggers FROM memories WHERE rooms_id_fk=? AND cards_id_fk IS NULL ORDER BY rooms_id_pk DESC').all(roomId).reverse().filter(active), 0);
    const mems = cap(db.prepare('SELECT content,triggers FROM memories WHERE cards_id_fk=? AND rooms_id_fk=? ORDER BY rooms_id_pk DESC')
        .all(card.id, roomId).reverse().filter(active), roomMems.reduce((a, r) => a + tok(r.content), 0));
    const memText = (roomMems.length || mems.length)
        ? [
            roomMems.length && 'What happened here:\n' + roomMems.map(m => '- ' + m.content).join('\n'),
            mems.length && `Things ${card.name} remembers:\n` + mems.map(m => '- ' + m.content).join('\n'),
        ].filter(Boolean).join('\n\n')
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

    // Context cap: drop oldest history lines until the prompt fits.
    const roomCtx = db.prepare('SELECT max_context FROM rooms WHERE rooms_id_pk=?').get(roomId)?.max_context || 0;
    const caps = [roomCtx, conn.context_size || 0].filter(v => v > 0);
    const maxCtx = caps.length ? Math.min(...caps) : 0;
    if (maxCtx > 0) {
        const overhead = Object.entries(parts).filter(([k]) => k !== 'Chat History')
            .reduce((a, [, v]) => a + v, 0);
        let histTok = parts['Chat History'];
        // ST-style: keep the opening message (greeting anchors the scene),
        // trim the middle, keep the recent tail.
        while (history.length > 2 && overhead + histTok > maxCtx) {
            const m = history.splice(1, 1)[0];
            histTok -= tok(m.name + ' ' + m.text);
        }
        parts['Chat History'] = histTok;
        parts['(capped)'] = maxCtx;
    }

    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
            ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })(),
        },
        body: JSON.stringify({
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
        }),
    });
    if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) { console.log('[gen] empty — raw:', JSON.stringify(data).slice(0, 600)); throw new Error('empty AI response'); }
    genStats[roomId] = {
        at: Date.now(), card: card.name,
        est: Object.values(parts).reduce((a, b) => a + b, 0),
        prompt_tokens: data?.usage?.prompt_tokens ?? null,
        completion_tokens: data?.usage?.completion_tokens ?? null,
        parts,
    };
    // Always drop a leading "Name:" / "**Name:**" / "[Name]" speaker tag —
    // the UI already labels messages; the tag only exists for steering.
    {
        const esc = card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^\\**\\[?${esc}\\]?\\**\\s*:\\s*`, 'i'), '').trimStart();
    }
    return text;
}

/**
 * Smart memories: ask the model to distill an excerpt into bullet facts,
 * stored as shared room memories. Runs after every N messages per room.
 */
export async function maybeSummarize(roomId) {
    const room = db.prepare('SELECT *, rooms_id_pk AS id FROM rooms WHERE rooms_id_pk=?').get(roomId);
    if (!room?.auto_mem) return;
    const lastId = db.prepare('SELECT MAX(id) m FROM messages WHERE rooms_id_fk=?').get(roomId).m || 0;
    if (lastId - room.mem_last_messages_id < (room.mem_every || 10)) return;
    const owner = db.prepare(`SELECT u.users_id_pk FROM members m JOIN users u ON u.users_id_pk=m.users_id_fk
        WHERE m.rooms_id_fk=? AND m.kind='human' ORDER BY m.users_id_fk LIMIT 1`).get(roomId);
    const p = room.api_profiles_id_fk ? db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE users_id_pk=?').get(room.api_profiles_id_fk) : null;
    const conn = p ? { ...p, apiUrl: p.api_url } : activeProfile(owner?.id);
    if (!conn?.apiUrl) return;
    const excerpt = db.prepare(
        MSG_SQL + ' WHERE m.rooms_id_fk=? AND m.messages_id_pk>? ORDER BY m.messages_id_pk LIMIT 30')
        .all(roomId, room.mem_last_messages_id);
    if (!excerpt.length) return;
    const roomCards = [
        ...db.prepare(`SELECT c.cards_id_pk,c.name FROM members m JOIN cards c ON c.cards_id_pk=m.cards_id_fk
            WHERE m.rooms_id_fk=? AND m.kind='ai'`).all(roomId),
        // Human members' persona cards — facts about players belong to them too.
        ...db.prepare(`SELECT pc.id,pc.name FROM members m JOIN cards pc
            ON pc.owner_users_id_fk=m.users_id_fk AND pc.is_persona=1
            WHERE m.rooms_id_fk=? AND m.kind='human'`).all(roomId),
    ];
    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
            ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })() },
        body: JSON.stringify({
            model: conn.model || 'local',
            messages: [
                { role: 'system', content: `You extract lasting facts from roleplay logs. Output ONLY bullet points (one per line, "- " prefix). Start each with the character it belongs to: [${roomCards.map(c => c.name).join('] [')}] or [shared] if room-wide. Then a type tag [fact], [event], [relationship] or [preference]. No narration.` },
                { role: 'user', content: excerpt.map(m => `${m.name}: ${m.text}`).join('\n') },
            ],
            temperature: 0.3, max_tokens: 2048,
        }),
    });
    if (!resp.ok) return;
    const text = (await resp.json())?.choices?.[0]?.message?.content?.trim() || '';
    const ins = db.prepare("INSERT INTO memories (cards_id_fk,rooms_id_fk,content,type,source) VALUES (NULL,?,?,?,'auto')");
    for (const line of text.split('\n')) {
        let fact = line.replace(/^\s*[-*•]\s*/, '').trim();
        fact = fact.replace(/^\[[^\]]+\]\s*/, ''); // strip any [Name] prefix — shared scope only
        const tag = fact.match(/^\[(fact|event|relationship|preference)\]\s*/i);
        const type = tag ? tag[1].toLowerCase() : 'fact';
        if (tag) fact = fact.slice(tag[0].length);
        if (fact.length > 10) ins.run(roomId, fact, type);
    }
    // Only advance the watermark once extraction actually ran — a failed
    // call retries on the next message instead of silently skipping.
    db.prepare('UPDATE rooms SET mem_last_messages_id=? WHERE rooms_id_pk=?').run(lastId, roomId);
    // Cap stored smart memories — oldest auto entries drop off.
    db.prepare(`DELETE FROM memories WHERE rooms_id_fk=? AND source='auto' AND id NOT IN
        (SELECT id FROM memories WHERE rooms_id_fk=? AND source='auto' ORDER BY rooms_id_pk  DESC LIMIT ?)`)
        .run(roomId, roomId, room.mem_max || 50);
}
