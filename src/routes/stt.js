// Speech-to-text: forwards composer audio to a Whisper sidecar exposing
// OpenAI's /v1/audio/transcriptions shape (faster-whisper-server, or any
// compatible endpoint — hosted Whisper works the same). Configured via
// BOLLOCKS_STT_URL; unset → the client hides the mic.
import { db } from '../db.js';
import { send, readRaw } from '../lib/util.js';
import { roomMember } from '../lib/access.js';

const STT = process.env.BOLLOCKS_STT_URL || '';
const PROBE_TTL = 30_000; // /api/stt pings the sidecar at most this often
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

// Reachability probe — any HTTP response counts as up (a 404 still means
// the service is alive). Cached so page loads don't hammer the sidecar.
let probe = { at: 0, up: false };
async function sttUp() {
    if (!STT) return false;
    if (Date.now() - probe.at < PROBE_TTL) return probe.up;
    try { await fetch(STT, { signal: AbortSignal.timeout(2000) }); probe.up = true; }
    catch { probe.up = false; }
    probe.at = Date.now();
    return probe.up;
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whisper doesn't know "SirRackington" — match each member name allowing
// whitespace at camel-case boundaries and replace with canonical spelling.
function correctNames(text, rid) {
    const names = db.prepare('SELECT c.name AS n FROM room_members m JOIN cards c ON c.cards_id_pk=m.cards_id_fk WHERE m.rooms_id_fk=?').all(rid);
    let out = text;
    for (const { n } of names) {
        if (!n) continue;
        const toks = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean).map(escRe);
        if (toks.length) out = out.replace(new RegExp(`\\b${toks.join('\\s*')}\\b`, 'gi'), n);
    }
    return out;
}

export default {
    // Capability flag for the client's mic button.
    'GET /api/stt': async (req, res) => send(res, 200, { enabled: await sttUp() }),

    'POST /api/stt': async (req, res, u) => {
        if (!STT) return send(res, 404, { error: 'STT not configured' });
        const rid = Number(new URL(req.url, 'http://x').searchParams.get('room'));
        if (!roomMember(rid, u)) return send(res, 403, { error: 'not a room member' });
        const ctype = (req.headers['content-type'] || '').split(';')[0] || 'audio/webm';
        const buf = await readRaw(req);
        if (!buf.length) return send(res, 400, { error: 'empty audio' });
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: ctype }), `clip.${EXT[ctype] || 'webm'}`);
        try {
            const r = await fetch(`${STT}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120_000) });
            if (!r.ok) return send(res, 502, { error: `stt upstream: HTTP ${r.status}` });
            const d = await r.json();
            send(res, 200, { text: correctNames(String(d?.text || '').trim(), rid) });
        } catch (e) {
            send(res, 502, { error: `stt upstream: ${e?.message || e}` });
        }
    },
};
