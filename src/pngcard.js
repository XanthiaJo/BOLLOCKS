import zlib from 'node:zlib';

/**
 * Extract character JSON from a SillyTavern PNG card.
 * Cards embed base64 JSON in tEXt/zTXt chunks named 'chara' (V1/V2) or
 * 'ccv3' (V3). Returns the parsed card object or null.
 */
export function extractCardJson(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
    let o = 8;
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o);
        const type = buf.toString('ascii', o + 4, o + 8);
        const data = buf.subarray(o + 8, o + 8 + len);
        if (type === 'tEXt' || type === 'zTXt') {
            const idx = data.indexOf(0);
            const kw = data.toString('ascii', 0, idx);
            if (kw === 'chara' || kw === 'ccv3') {
                let raw;
                try {
                    raw = type === 'tEXt'
                        ? data.subarray(idx + 1).toString('utf8')
                        : zlib.inflateSync(data.subarray(idx + 2)).toString('utf8');
                    // Chunk payload is base64 JSON
                    return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
                } catch {
                    return null;
                }
            }
        }
        o += 12 + len;
        if (type === 'IEND') break;
    }
    return null;
}

/** Normalize V1/V2/V3 card JSON into our flat field set. */
export function normalizeCard(raw) {
    const d = raw?.data && typeof raw.data === 'object' ? raw.data : (raw || {});
    return {
        name: d.name || 'Unnamed',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || d.first_message || '',
        mes_example: d.mes_example || '',
        system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '',
        alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
        tags: Array.isArray(d.tags) ? d.tags : (typeof d.tags === 'string' ? d.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
        creator: d.creator || '',
        creatorcomment: d.creatorcomment || d.creator_notes || '',
        character_version: d.character_version || '',
    };
}
