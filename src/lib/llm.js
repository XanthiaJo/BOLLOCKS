import { db } from '../db.js';

// Persist each LLM call for later inspection — genStats only keeps the last
// request in memory, and prod has no DB access. Newest 50 rows per room.
export function logPrompt(roomId, cardId, kind, reqBody, text, usage) {
    db.prepare('INSERT INTO prompt_logs (rooms_id_fk,cards_id_fk,kind,request,response,prompt_tokens,completion_tokens) VALUES (?,?,?,?,?,?,?)')
        .run(roomId, cardId, kind, JSON.stringify(reqBody), text || '', usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null);
    db.prepare('DELETE FROM prompt_logs WHERE rooms_id_fk=? AND prompt_logs_id_pk NOT IN (SELECT prompt_logs_id_pk FROM prompt_logs WHERE rooms_id_fk=? ORDER BY prompt_logs_id_pk DESC LIMIT 50)')
        .run(roomId, roomId);
}
export const tok = s => Math.ceil((s || '').length / 4); // rough chars/4 estimate

// POST /chat/completions — one place for the connection boilerplate
// (url normalize, bearer key, custom headers). Callers keep their own
// .ok handling since failures mean different things per caller.
export const llmFetch = (conn, reqBody) => fetch(`${conn.apiUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}),
        ...(() => { try { return JSON.parse(conn.headers || '{}'); } catch { return {}; } })(),
    },
    body: JSON.stringify(reqBody),
});
