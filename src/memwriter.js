// The memory-writer: distills chat into smart memories, scene state, and
// story threads on the room's memory profile. Everything here is a
// background pass — it runs after messages land, never inside a reply.
import { db, MSG_SQL } from './db.js';
import { push } from './lib/sse.js';
import { dedupeNew, dedupeRoom } from './lib/memdedupe.js';
import { llmFetch, logPrompt, tok } from './lib/llm.js';
import {
    MEM_EXTRACT_PROMPT, MEM_TRIGGERS_SUFFIX, MEM_ARCS_SUFFIX,
    MEM_SWEEP_PROMPT, MEM_STATE_PROMPT, memProfileFor,
} from './lib/memprompts.js';

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
    // Read-only profiles: injection still reads stored memories, but the
    // memory-writer never mutates them.
    if (mem.mem_readonly) return;
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
        ? ' If the memory you write restates, updates, or gives a newer version of ANY numbered memory — even in different words — you MUST write it as "- [supersede N] …" where N is its number: the old version is retired and keeping both is never allowed. Paraphrased retellings of an ongoing event supersede its last telling.'
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
    const resp = await llmFetch(conn, reqBody);
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
    // A closed thread revived by an [arc] beat re-anchors its span at the
    // current message — same rule as the reopen route, so a second close
    // consolidates only the continuation.
    const upArc = db.prepare(`UPDATE room_arcs SET summary=?, status='open', updated=datetime('now'),
        opened_messages_id_fk=CASE WHEN status<>'open' THEN ? ELSE opened_messages_id_fk END,
        closed_messages_id_fk=CASE WHEN status<>'open' THEN NULL ELSE closed_messages_id_fk END
        WHERE room_arcs_id_pk=?`);
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
            else if (ex) { if (summary) upArc.run(summary, lastId, ex.id); }
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
            // Untagged retellings of a still-live event chain the same way —
            // the writer saw the duplicates and didn't tag, so the script
            // decides by trigger overlap instead.
            dedupeNew(roomId, mid);
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
    // Optional LLM sweep on its own cadence — merges paraphrased duplicates
    // before the cap machinery below has to judge what's still over.
    if (mem.mem_sweep) await maybeLlmSweep(roomId, mem, conn);
    // Consolidation before eviction: under cap pressure, sweep for
    // retellings first — a merged pair frees a live slot without retiring
    // anything, so pileups collapse instead of evicting real memories.
    const totalCap = mem.mem_max || 0;
    const counts = db.prepare(`SELECT m.type AS t, COUNT(*) AS c FROM memories m
        JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.superseded_by_memories_id_fk IS NULL
          AND m.room_arcs_id_fk IS NULL GROUP BY m.type`).all(roomId);
    if ((totalCap > 0 && counts.filter(x => x.t !== 'state').reduce((a, x) => a + x.c, 0) > totalCap)
        || counts.some(({ t, c }) => (mem['mem_max_' + t] || 0) > 0 && c > mem['mem_max_' + t]))
        dedupeRoom(roomId);
    // Cap stored smart memories per type — oldest entries of each type
    // retire (tombstone — self-supersede, never deleted). Superseded and
    // folded-arc rows don't occupy cap slots, and retiring a chain head
    // keeps its drafts superseded rather than resurrecting them like a
    // hard delete did.
    for (const [type, col] of [['fact','mem_max_fact'],['event','mem_max_event'],['relationship','mem_max_relationship'],['preference','mem_max_preference']]) {
        const cap = mem[col] || 0;
        if (cap <= 0) continue;
        db.prepare(`UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk WHERE origin='smart' AND type=? AND superseded_by_memories_id_fk IS NULL AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type=? AND m.superseded_by_memories_id_fk IS NULL AND m.room_arcs_id_fk IS NULL
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' AND m2.type=? AND m2.superseded_by_memories_id_fk IS NULL AND m2.room_arcs_id_fk IS NULL ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(type, roomId, type, roomId, type, cap);
    }
    // Global cap (mem_max) as a safety net across all types.
    if (totalCap > 0) {
        db.prepare(`UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk WHERE origin='smart' AND type!='state' AND superseded_by_memories_id_fk IS NULL AND memories_id_pk IN
            (SELECT m.memories_id_pk FROM memories m JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
             WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type!='state' AND m.superseded_by_memories_id_fk IS NULL AND m.room_arcs_id_fk IS NULL
             AND m.memories_id_pk NOT IN
                (SELECT m2.memories_id_pk FROM memories m2 JOIN room_memories rm2 ON rm2.memories_id_fk=m2.memories_id_pk
                 WHERE rm2.rooms_id_fk=? AND m2.origin='smart' AND m2.type!='state' AND m2.superseded_by_memories_id_fk IS NULL AND m2.room_arcs_id_fk IS NULL ORDER BY m2.memories_id_pk DESC LIMIT ?))`)
            .run(roomId, roomId, totalCap);
    }
    // Dormancy prune: triggered smart memories that haven't fired into a
    // prompt within the last mem_prune_messages room messages tombstone
    // themselves. Canon (no triggers) is exempt — always injected by
    // design — and a memory gets the full window from creation to prove
    // itself before it can be retired.
    const pruneMsgs = mem.mem_prune_messages || 0;
    if (pruneMsgs > 0) {
        const wm = db.prepare('SELECT messages_id_pk AS id, send_date FROM messages WHERE rooms_id_fk=? ORDER BY messages_id_pk DESC LIMIT 1 OFFSET ?')
            .get(roomId, pruneMsgs);
        if (wm) db.prepare(`UPDATE memories SET superseded_by_memories_id_fk=memories_id_pk
            WHERE origin='smart' AND superseded_by_memories_id_fk IS NULL AND room_arcs_id_fk IS NULL AND type!='state'
              AND EXISTS (SELECT 1 FROM memory_triggers mt WHERE mt.memories_id_fk=memories.memories_id_pk)
              AND memories_id_pk IN (SELECT memories_id_fk FROM room_memories WHERE rooms_id_fk=?)
              AND created < ?
              AND (last_fired_messages_id_fk IS NULL OR last_fired_messages_id_fk < ?)`)
            .run(roomId, wm.send_date, wm.id);
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
        const resp = await llmFetch(conn, reqBody);
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
            // Fuzzy key fallback — small models sometimes rename a subject
            // between passes ("Buddy's ear" → "Buddy"), which otherwise diffs
            // as retract+insert and churns the audit chain. Map an unmatched
            // new key onto an old row when one name contains the other
            // word-wise AND exactly one unclaimed row qualifies — ambiguity
            // means a genuinely new subject, so it gets its own row.
            const norm = k => (k || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
            const fuzzy = nk => {
                const pad = ` ${nk} `;
                const cands = rows.filter(r => r.state_key && !seen.has(r.id)).filter(r => {
                    const rk = ` ${norm(r.state_key)} `;
                    return rk !== pad && (rk.includes(pad) || pad.includes(rk));
                });
                return cands.length === 1 ? cands[0] : undefined;
            };
            const ins = db.prepare("INSERT INTO memories (content,type,origin,state_key) VALUES (?, 'state', 'smart', ?)");
            const linkRoom = db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)');
            const sup = db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?');
            for (const [subject, val] of entries) {
                const content = `${subject} — ${val}`;
                const ex = byKey.get(subject.toLowerCase()) ?? fuzzy(norm(subject));
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

// LLM dedupe sweep: every mem_sweep_every extraction runs, the model
// reviews the room's live memories and merges true duplicates — the
// paraphrased retellings the scripted trigger-overlap sweep can't see.
// Uses the profile's sweep API profile, falling back to the extraction
// connection the caller already resolved.
async function maybeLlmSweep(roomId, mem, fallbackConn) {
    const room = db.prepare('SELECT mem_extract_count, owner_users_id_fk FROM rooms WHERE rooms_id_pk=?').get(roomId);
    const every = Math.max(1, mem.mem_sweep_every || 5);
    if ((room.mem_extract_count || 0) % every !== 0) return;
    let conn = fallbackConn;
    if (mem.sweep_api_profiles_id_fk) {
        const sw = db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=?').get(mem.sweep_api_profiles_id_fk);
        // Same ownership gate as extraction — a profile owned by someone
        // else is ignored, not used.
        if (sw?.api_url && sw.users_id_fk === room.owner_users_id_fk) conn = { ...sw, apiUrl: sw.api_url };
    }
    // The candidate list mirrors what extraction offers for [supersede N]:
    // live, smart, non-state, unfolded — plus user_sorted rows stay out so
    // hand-arranged chains are never rewritten by a sweep.
    const rows = db.prepare(`SELECT m.memories_id_pk AS id, m.type, m.content FROM memories m
        JOIN room_memories rm ON rm.memories_id_fk=m.memories_id_pk
        WHERE rm.rooms_id_fk=? AND m.origin='smart' AND m.type!='state' AND m.room_arcs_id_fk IS NULL
          AND m.superseded_by_memories_id_fk IS NULL AND m.user_sorted IS NOT 1
        ORDER BY m.memories_id_pk LIMIT 100`).all(roomId);
    if (rows.length < 2) return;
    const reqBody = {
        model: conn.model || 'local',
        messages: [
            { role: 'system', content: MEM_SWEEP_PROMPT },
            { role: 'user', content: 'Live memories (numbered):\n' + rows.map((m, i) => `${i + 1}) [${m.type}] ${m.content}`).join('\n') },
        ],
        temperature: 0.2, max_tokens: mem.mem_unlimited ? -1 : (mem.mem_gen_budget || mem.mem_response_length || 2000),
    };
    try {
        const resp = await llmFetch(conn, reqBody);
        if (!resp.ok) return;
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim() || '';
        logPrompt(roomId, null, 'sweep', reqBody, text, data?.usage);
        const ins = db.prepare("INSERT INTO memories (content,type,origin) VALUES (?,?, 'smart')");
        const insTrig = db.prepare('INSERT OR IGNORE INTO memory_triggers (memories_id_fk,word) VALUES (?,?)');
        const linkRoom = db.prepare('INSERT INTO room_memories (rooms_id_fk,memories_id_fk) VALUES (?,?)');
        const sup = db.prepare('UPDATE memories SET superseded_by_memories_id_fk=? WHERE memories_id_pk=?');
        const retired = new Set();
        let merged = 0;
        for (const line of text.split('\n')) {
            let fact = line.replace(/^\s*[-*•]\s*/, '').trim();
            let type = 'fact'; const supersedes = [];
            for (let i = 0; i < 6; i++) {
                const t = fact.match(/^\[([^\]]+)\]\s*/);
                if (!t) break;
                const w = t[1].trim().toLowerCase();
                if (['fact', 'event', 'relationship', 'preference'].includes(w)) type = w;
                else if (/^supersedes?\s*[:#]?\s*\d+$/.test(w)) supersedes.push(parseInt(w.match(/\d+/)[0], 10));
                fact = fact.slice(t[0].length).trimStart();
            }
            const tr = fact.match(/\(\s*triggers?\s*:\s*([^)]*)\)/i) || fact.match(/\(([^)]*)\)\s*$/);
            let triggers = '';
            if (tr) {
                triggers = tr[1].split(',').map(s => s.trim().replace(/^triggers?\s*:/i, '').toLowerCase()).filter(Boolean).join(',');
                fact = (fact.slice(0, tr.index) + fact.slice(tr.index + tr[0].length)).trim();
            }
            // Only merge lines act — a sweep never creates free memories.
            const targets = supersedes.map(n => rows[n - 1]).filter(t => t && !retired.has(t.id));
            if (!targets.length || fact.length <= 10) continue;
            const mid = ins.run(fact, type).lastInsertRowid;
            for (const w of triggers.split(',')) { const word = w.trim(); if (word) insTrig.run(mid, word); }
            linkRoom.run(roomId, mid);
            for (const t of targets) { sup.run(mid, t.id); retired.add(t.id); }
            merged++;
        }
        if (mem.mem_activity && merged) console.log(`[mem] activity: llm sweep merged ${merged} group(s) in room ${roomId}`);
    } catch (e) {
        if (mem.mem_activity) console.log(`[mem] activity: llm sweep failed for room ${roomId} (${e.message})`);
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
    if (!mem || mem.mem_readonly) return;
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
        const resp = await llmFetch(conn, reqBody);
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
