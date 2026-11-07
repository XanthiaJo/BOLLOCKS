import { db, activeProfile } from './db.js';

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
        'SELECT name, text, kind FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 30'
    ).all(roomId).reverse();

    const system = [
        card.system_prompt || `You are ${card.name}.`,
        card.description && `Description:\n${card.description}`,
        card.personality && `Personality:\n${card.personality}`,
        card.scenario && `Scenario:\n${card.scenario}`,
        card.mes_example && `Example dialogue:\n${card.mes_example}`,
        `You are an NPC in a shared roleplay. Write ONLY ${card.name}'s next message.` +
            (card.post_history_instructions ? ` ${card.post_history_instructions}` : ''),
    ].filter(Boolean).join('\n\n');

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
                ...history.map(m => ({
                    role: 'user',
                    content: `[${m.name}] ${m.text}`,
                })),
            ],
            temperature: 0.8,
            max_tokens: 512,
        }),
    });
    if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty AI response');
    return text;
}
