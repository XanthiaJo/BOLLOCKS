import { db, activeProfile } from './db.js';

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
    const owner = db.prepare(`SELECT u.id FROM members m JOIN users u ON u.id=m.user_id
        WHERE m.room_id=? AND m.kind='human' ORDER BY m.user_id LIMIT 1`).get(roomId);
    // Card's own profile wins; otherwise the room owner's active profile.
    const p = card.profile_id
        ? db.prepare('SELECT * FROM api_profiles WHERE id=?').get(card.profile_id)
        : null;
    const conn = p ? { apiUrl: p.api_url, model: p.model, key: p.key } : activeProfile(owner?.id);
    if (!conn?.apiUrl) throw new Error('no API connection configured — set one on the Connection page');

    const history = db.prepare(
        'SELECT name, text, kind, card_id, sender_user_id FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 30'
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
        JOIN cards c ON c.id=m.card_id WHERE m.room_id=? AND m.kind='ai' AND c.id!=?`)
        .all(roomId, card.id);

    // Keyword-triggered world entries: constant entries always in; keyed
    // entries fire when a key appears in recent chat or the card's fields.
    const scanText = (history.map(m => `${m.name} ${m.text}`).join('\n')
        + ' ' + (card.name || '') + ' ' + (card.description || '')).toLowerCase();
    const book = db.prepare('SELECT world_book_id FROM rooms WHERE id=?').get(roomId);
    const world = book?.world_book_id
        ? db.prepare('SELECT * FROM world_entries WHERE book_id=? AND enabled=1 ORDER BY ord,id')
            .all(book.world_book_id)
            .filter(e => e.constant || (
                JSON.parse(e.keys || '[]').some(k => k && scanText.includes(k.toLowerCase()))
                && JSON.parse(e.keysecondary || '[]').every(k => !k || scanText.includes(k.toLowerCase()))))
        : [];
    const worldText = world.length
        ? 'World info:\n' + world.map(e => e.content).join('\n\n')
        : null;

    const system = [
        card.system_prompt || `You are ${card.name}.`,
        worldText,
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

    const resp = await fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
        },
        body: JSON.stringify({
            model: conn.model || 'local',
            messages: [
                { role: 'system', content: system },
                // The card's own past lines are its voice (assistant);
                // everyone else's lines are tagged context (user).
                ...history.map(m => m.card_id === card.id
                    ? { role: 'assistant', content: m.text }
                    : { role: 'user', content: `${m.name}: ${m.text}` }),
                // Final nudge — primes the model to continue as this character.
                { role: 'user', content: `${card.name}:` },
            ],
            temperature: 0.8,
            max_tokens: 512,
        }),
    });
    if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty AI response');
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
