// Connection routes: API profiles, memory profiles, /models proxy.
import { db } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { MEM_EXTRACT_PROMPT, PROMPT_BLOCKS } from '../generate.js';

export default {
    'POST /api/models': async (req, res, u) => {
        const b = await readBody(req);
        let apiUrl = b.apiUrl || '', key = b.key || '', headers = b.headers;
        if (b.profileId) {
            const p = db.prepare('SELECT *, api_profiles_id_pk AS id FROM api_profiles WHERE api_profiles_id_pk=? AND users_id_fk=?').get(b.profileId, u.users_id_pk);
            if (p) { apiUrl = apiUrl || p.api_url; key = key || p.key; headers = headers === undefined ? p.headers : headers; }
        }
        if (!apiUrl) return send(res, 400, { error: 'api url required' });
        try {
            const r = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
                headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
                    ...(() => { try { return JSON.parse(headers || '{}'); } catch { return {}; } })() },
            });
            const d = await r.json();
            send(res, 200, { models: (d.data || []).map(m => m.id).sort() });
        } catch (e) { send(res, 502, { error: String(e.message || e) }); }
    },
    'GET /api/profiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT api_profiles_id_pk AS id,name,api_url,model,active,strip_prefix,headers,context_size,max_response,(key!=\'\') has_key FROM api_profiles WHERE users_id_fk=? ORDER BY api_profiles_id_pk').all(u.users_id_pk);
        send(res, 200, { profiles });
    },
    'POST /api/profiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const first = !db.prepare('SELECT 1 FROM api_profiles WHERE users_id_fk=?').get(u.users_id_pk);
        const id = db.prepare('INSERT INTO api_profiles (users_id_fk,name,api_url,model,key,active,strip_prefix) VALUES (?,?,?,?,?,?,?)')
            .run(u.users_id_pk, b.name, b.apiUrl || '', b.model || '', b.key || '', first ? 1 : 0, b.stripPrefix === false ? 0 : 1).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/profiles/update': async (req, res, u) => {
        const b = await readBody(req);
        const sets = ['name=?', 'api_url=?', 'model=?'];
        const args = [b.name, b.apiUrl, b.model];
        if (b.headers !== undefined) { sets.push('headers=?'); args.push(b.headers || '{}'); }
        if (b.contextSize !== undefined) { sets.push('context_size=?'); args.push(Number(b.contextSize) || 0); }
        if (b.maxResponse !== undefined) { sets.push('max_response=?'); args.push(Number(b.maxResponse) || 2048); }
        if (b.stripPrefix !== undefined) { sets.push('strip_prefix=?'); args.push(b.stripPrefix ? 1 : 0); }
        if (b.key) { sets.push('key=?'); args.push(b.key); }
        args.push(b.id || b.world_books_id_pk, u.users_id_pk);
        db.prepare(`UPDATE api_profiles SET ${sets.join(',')} WHERE api_profiles_id_pk=? AND users_id_fk=?`).run(...args);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/activate': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE api_profiles SET active=0 WHERE users_id_fk=?').run(u.users_id_pk);
        db.prepare('UPDATE api_profiles SET active=1 WHERE api_profiles_id_pk=? AND users_id_fk=?').run(b.id || b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/profiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('DELETE FROM api_profiles WHERE api_profiles_id_pk=? AND users_id_fk=?').run(b.id || b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    // Smart-memory profiles: named presets of the mem_* room settings.
    'GET /api/memprofiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT * FROM mem_profiles WHERE users_id_fk=? ORDER BY mem_profiles_id_pk').all(u.users_id_pk);
        send(res, 200, { profiles, defaultPrompt: MEM_EXTRACT_PROMPT });
    },
    'POST /api/memprofiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const vals = [b.auto ? 1 : 0, b.every ?? 10, b.budget ?? 800, b.max ?? 50,
            b.maxFact ?? 50, b.maxEvent ?? 50, b.maxRel ?? 50, b.maxPref ?? 50,
            b.extractionPrompt || '', b.contextThreshold ?? 80, b.responseLength ?? 2000,
            b.genBudget ?? 2000, b.unlimited ? 1 : 0, (b.unified ?? 1) ? 1 : 0, b.triggers ? 1 : 0,
            b.autotune ? 1 : 0, b.refresh ?? 1, b.activity ? 1 : 0, b.profileId ?? 0];
        const id = db.prepare(`INSERT INTO mem_profiles (users_id_fk,name,auto_mem,mem_every,mem_budget,mem_max,
            mem_max_fact,mem_max_event,mem_max_relationship,mem_max_preference,mem_extraction_prompt,
            mem_context_threshold,mem_response_length,mem_gen_budget,mem_unlimited,mem_unified,mem_triggers,
            mem_autotune,mem_refresh,mem_activity,mem_extraction_profile_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, b.name, ...vals).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/memprofiles/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE mem_profiles SET name=COALESCE(NULLIF(?,''),name), auto_mem=?, mem_every=?, mem_budget=?, mem_max=?,
            mem_max_fact=?, mem_max_event=?, mem_max_relationship=?, mem_max_preference=?,
            mem_extraction_prompt=?, mem_context_threshold=?, mem_response_length=?,
            mem_gen_budget=?, mem_unlimited=?, mem_unified=?, mem_triggers=?,
            mem_autotune=?, mem_refresh=?, mem_activity=?, mem_extraction_profile_id=?
            WHERE mem_profiles_id_pk=? AND users_id_fk=?`)
            .run(String(b.name ?? '').trim(), b.auto ? 1 : 0, b.every ?? 10, b.budget ?? 800, b.max ?? 50,
                b.maxFact ?? 50, b.maxEvent ?? 50, b.maxRel ?? 50, b.maxPref ?? 50,
                b.extractionPrompt || '', b.contextThreshold ?? 80, b.responseLength ?? 2000,
                b.genBudget ?? 2000, b.unlimited ? 1 : 0, (b.unified ?? 1) ? 1 : 0, b.triggers ? 1 : 0,
                b.autotune ? 1 : 0, b.refresh ?? 1, b.activity ? 1 : 0, b.profileId ?? 0,
                b.id, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/memprofiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        // Rooms following the deleted profile are re-pointed at another of
        // the SAME user's profiles (0 = feature-less room columns only when
        // none remain). Only the owner's own rooms can legitimately follow.
        db.prepare(`UPDATE rooms SET mem_profiles_id_fk=COALESCE((SELECT mem_profiles_id_pk FROM mem_profiles WHERE mem_profiles_id_pk<>? AND users_id_fk=? ORDER BY mem_profiles_id_pk LIMIT 1),0)
            WHERE mem_profiles_id_fk=? AND owner_users_id_fk=?`).run(b.id, u.users_id_pk, b.id, u.users_id_pk);
        db.prepare('DELETE FROM mem_profiles WHERE mem_profiles_id_pk=? AND users_id_fk=?').run(b.id, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    // Injection profiles: named prompt-assembly presets (section order today,
    // templates/block triggers later). The user's `active` one applies to all
    // their generations — layout survives swapping API connections.
    'GET /api/promptprofiles': async (req, res, u) => {
        const profiles = db.prepare('SELECT * FROM prompt_profiles WHERE users_id_fk=? ORDER BY prompt_profiles_id_pk').all(u.users_id_pk);
        send(res, 200, { profiles, promptBlocks: PROMPT_BLOCKS });
    },
    'POST /api/promptprofiles': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const first = !db.prepare('SELECT 1 FROM prompt_profiles WHERE users_id_fk=?').get(u.users_id_pk);
        const id = db.prepare('INSERT INTO prompt_profiles (users_id_fk,name,prompt_order,active,include_time) VALUES (?,?,?,?,?)')
            .run(u.users_id_pk, b.name, b.order ? JSON.stringify(b.order) : null, first ? 1 : 0, b.includeTime ? 1 : 0).lastInsertRowid;
        send(res, 200, { id });
    },
    'POST /api/promptprofiles/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE prompt_profiles SET name=COALESCE(NULLIF(?,''),name), prompt_order=?, include_time=?
            WHERE prompt_profiles_id_pk=? AND users_id_fk=?`)
            .run(String(b.name ?? '').trim(), b.order ? JSON.stringify(b.order) : null, b.includeTime ? 1 : 0, b.id, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/promptprofiles/activate': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare('UPDATE prompt_profiles SET active=0 WHERE users_id_fk=?').run(u.users_id_pk);
        db.prepare('UPDATE prompt_profiles SET active=1 WHERE prompt_profiles_id_pk=? AND users_id_fk=?').run(b.id, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/promptprofiles/delete': async (req, res, u) => {
        const b = await readBody(req);
        // Deleting the active profile falls back to the next one, so a
        // generation never silently loses its assigned layout.
        const wasActive = db.prepare('SELECT active FROM prompt_profiles WHERE prompt_profiles_id_pk=? AND users_id_fk=?').get(b.id, u.users_id_pk)?.active;
        db.prepare('DELETE FROM prompt_profiles WHERE prompt_profiles_id_pk=? AND users_id_fk=?').run(b.id, u.users_id_pk);
        if (wasActive) db.prepare('UPDATE prompt_profiles SET active=1 WHERE users_id_fk=? ORDER BY prompt_profiles_id_pk LIMIT 1').run(u.users_id_pk);
        send(res, 200, { ok: true });
    },
};
