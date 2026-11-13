// Upgrade test: build a populated DB with an older build (the PR's base
// branch plus the deployed beta/master branches), then boot this checkout on
// it and check nothing was lost, FKs and integrity are clean, and the
// migrations are idempotent. Also runs the same checks on a fresh DB.
//
// Refs come from UPGRADE_FROM (space/comma separated) or default to
// origin/$BASE_REF, origin/dev, origin/beta, origin/master — whichever exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `bollocks-${name}-`));

function upgradeRefs() {
    const wanted = process.env.UPGRADE_FROM
        ? process.env.UPGRADE_FROM.split(/[\s,]+/).filter(Boolean)
        : [process.env.BASE_REF && `origin/${process.env.BASE_REF}`, 'origin/dev', 'origin/beta', 'origin/master'].filter(Boolean);
    const seen = new Map();
    for (const ref of wanted) {
        let sha;
        try { sha = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`); } catch { continue; }
        if (!seen.has(sha)) seen.set(sha, ref);
    }
    return [...seen].map(([sha, ref]) => ({ sha, ref }));
}

function extract(sha) {
    const dir = tmp('src');
    execFileSync('sh', ['-c', `git archive ${sha} src public package.json | tar -x -C "${dir}"`], { cwd: ROOT });
    return dir;
}

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
});

async function boot(appDir, dataDir) {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: appDir, env: { ...process.env, PORT: String(port), BOLLOCKS_DATA: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start within 15s:\n${log}`)), 15000);
        const onData = d => { log += d; if (/listening on/.test(log)) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', onData);
        child.stderr.on('data', d => { log += d; });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}) during startup:\n${log}`)); });
    });
    const base = `http://127.0.0.1:${port}/api/`;
    let token = '';
    const call = async (method, p, body) => {
        const r = await fetch(base + p, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: r.status, json };
    };
    return {
        post: (p, b) => call('POST', p, b ?? {}),
        get: p => call('GET', p),
        login: async (handle, password = 'changeme') => {
            const r = await call('POST', 'login', { handle, password });
            assert.equal(r.status, 200, `login as ${handle} failed: ${JSON.stringify(r.json)}`);
            token = r.json.token;
        },
        stop: () => new Promise(resolve => {
            child.removeAllListeners('exit');
            if (child.exitCode !== null) return resolve();
            child.on('exit', resolve);
            child.kill('SIGTERM');
        }),
    };
}

// Realistic data touching every link table, created through the API of
// whichever build is running.
async function populate(s) {
    await s.login('creamms');
    const failed = [];
    const ok = async (p, b) => {
        const r = await s.post(p, b);
        if (r.status === 200 && !r.json?.error) return r.json;
        failed.push(`POST /api/${p} -> ${r.status} ${JSON.stringify(r.json)}`);
        return null;
    };
    const room = (await ok('rooms', { name: 'Upgrade Room' }))?.id;
    await ok('room/trigger', { room, mode: 'manual' });
    const card = (await ok('cards', { name: 'Aria', description: 'A test character.' }))?.id;
    await ok('members', { room, cardId: card });
    await ok('members/talkativeness', { room, cardId: card, value: 40 });
    const profile = (await ok('profiles', { name: 'Test API', apiUrl: 'http://127.0.0.1:9/v1', model: 'm', key: 'k' }))?.id;
    const memProfile = (await ok('memprofiles', { name: 'Test mem', profileId: profile }))?.id;
    await ok('room/memsettings', { room, memProfile });
    await ok('room/settings', { room, maxContext: 4000 });
    const book = (await ok('world/books', { name: 'Lore' }))?.id;
    await ok('world', { book, comment: 'House', content: 'The house is old.', keys: 'house,aria', keysecondary: 'night' });
    await ok('world/link', { room, book });
    const cardMem = (await ok('memories', { room, cardId: card, content: 'Aria likes tea.', type: 'preference', triggers: 'tea' }))?.id;
    const roomMem = (await ok('memories', { room, content: 'The house has a red door.', triggers: 'door' }))?.id;
    await ok('memories/update', { id: roomMem, origin: 'smart' });
    await ok('say', { room, text: 'Hello there.' });
    return { room, card, book, cardMem, roomMem, failed };
}

function snapshot(dataDir) {
    const db = new DatabaseSync(path.join(dataDir, 'app.db'));
    try {
        const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const counts = Object.fromEntries(tables.map(t => [t.name, db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c]));
        const schema = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
            .map(r => `${r.type} ${r.name}: ${r.sql}`);
        const integrity = db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check).join('; ');
        let fkViolations;
        try { fkViolations = db.prepare('PRAGMA foreign_key_check').all().map(r => `${r.table} row ${r.rowid} -> ${r.parent}`); }
        catch (e) { fkViolations = [`foreign_key_check failed: ${e.message}`]; }
        const names = new Set(tables.map(t => t.name));
        const badFks = [];
        for (const t of names) {
            for (const fk of db.prepare(`PRAGMA foreign_key_list("${t}")`).all()) {
                if (!names.has(fk.table)) { badFks.push(`${t}.${fk.from} -> missing table ${fk.table}`); continue; }
                const cols = db.prepare(`PRAGMA table_info("${fk.table}")`).all();
                const ok = fk.to ? cols.some(c => c.name === fk.to) : cols.some(c => c.pk);
                if (!ok) badFks.push(`${t}.${fk.from} -> ${fk.table}(${fk.to ?? 'pk'}) which does not exist`);
            }
        }
        return { counts, schema, integrity, fkViolations, badFks };
    } finally { db.close(); }
}

function assertHealthy(snap, label) {
    assert.equal(snap.integrity, 'ok', `${label}: integrity_check`);
    assert.deepEqual(snap.fkViolations, [], `${label}: foreign_key_check`);
    assert.deepEqual(snap.badFks, [], `${label}: FKs pointing at renamed/removed columns`);
}

function assertNothingLost(before, after, label) {
    const lost = Object.entries(before.counts)
        .filter(([t, n]) => t in after.counts && after.counts[t] < n)
        .map(([t, n]) => `${t}: ${n} -> ${after.counts[t]}`);
    assert.deepEqual(lost, [], `${label}: rows lost during migration`);
}

// Boot this checkout twice more on `dataDir`, checking health, idempotency
// and that the populated data is still reachable through the current API.
async function upgradeAndVerify(dataDir, before, ids, label) {
    const s1 = await boot(ROOT, dataDir);
    await s1.stop();
    const first = snapshot(dataDir);
    assertHealthy(first, `${label}, first boot`);
    assertNothingLost(before, first, `${label}, first boot`);

    const s2 = await boot(ROOT, dataDir);
    try {
        await s2.login('creamms');
        if (ids.room) {
            const rooms = (await s2.get('rooms')).json.rooms || [];
            assert.ok(rooms.some(r => r.id === ids.room), `${label}: room ${ids.room} missing from /api/rooms after upgrade`);
            const mems = (await s2.get(`memories?card=-1&room=${ids.room}`)).json.memories || [];
            const memIds = mems.map(m => m.id);
            for (const id of [ids.cardMem, ids.roomMem].filter(Boolean))
                assert.ok(memIds.includes(id), `${label}: memory ${id} no longer linked to room ${ids.room} after upgrade`);
            if (ids.cardMem && ids.card)
                assert.equal(mems.find(m => m.id === ids.cardMem)?.cards_id_fk, ids.card, `${label}: memory ${ids.cardMem} lost its card link`);
        }
    } finally { await s2.stop(); }
    const second = snapshot(dataDir);
    assertHealthy(second, `${label}, second boot`);
    const { sessions: _s1, ...c1 } = first.counts;
    const { sessions: _s2, ...c2 } = second.counts;
    assert.deepEqual(c2, c1, `${label}: second boot changed row counts (migrations not idempotent)`);
    assert.deepEqual(second.schema, first.schema, `${label}: second boot changed the schema (migrations not idempotent)`);
}

test('fresh DB: current build boots, populates and reboots cleanly', async () => {
    const dataDir = tmp('data');
    const s = await boot(ROOT, dataDir);
    let ids;
    try { ids = await populate(s); } finally { await s.stop(); }
    assert.deepEqual(ids.failed, [], 'API calls that failed on a fresh DB with the current build');
    const before = snapshot(dataDir);
    assertHealthy(before, 'fresh DB');
    await upgradeAndVerify(dataDir, before, ids, 'fresh DB');
});

const refs = upgradeRefs();
if (!refs.length) test('upgrade from older builds', { skip: 'no upgrade refs found (fetch origin or set UPGRADE_FROM)' }, () => {});
for (const { ref, sha } of refs) {
    test(`upgrade from ${ref} (${sha.slice(0, 7)})`, async t => {
        const appDir = extract(sha);
        const dataDir = tmp('data');
        let old;
        try { old = await boot(appDir, dataDir); } catch (e) {
            // An old build that can't start on an empty DB can't produce one to upgrade.
            // Not this PR's fault, but say so loudly.
            t.diagnostic(`${ref} cannot boot on a fresh DB: ${e.message.split('\n').find(l => /Error/.test(l)) || e.message}`);
            return t.skip(`${ref} cannot boot on a fresh DB`);
        }
        let ids;
        try { ids = await populate(old); } finally { await old.stop(); }
        assert.ok(ids.room && ids.card, `could not populate a DB with ${ref}: ${JSON.stringify(ids)}`);
        const before = snapshot(dataDir);
        await upgradeAndVerify(dataDir, before, ids, `upgrade from ${ref}`);
    });
}
