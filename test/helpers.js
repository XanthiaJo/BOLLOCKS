// Shared server harness for functional tests.
//
// boot() spawns src/server.js on a free port with an isolated BOLLOCKS_DATA
// directory and returns a small client that keeps a session the way the
// browser does: a Bearer token plus the mp_token cookie set by /api/login.
// Unlike test/upgrade.test.js's embedded harness (which is scoped to
// migration checks), this one is reusable across suites.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `bollocks-${name}-`));

const freePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
    });
    srv.on('error', reject);
});

/** Spawn the app. Returns client helpers; call stop() when done. */
export async function boot(dataDir, env = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), BOLLOCKS_DATA: dataDir, ...env },
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

    const base = `http://127.0.0.1:${port}`;
    let token = '', cookie = '';
    const creds = () => ({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
    });

    // Raw request: no redirect following, optional JSON body, creds unless
    // disabled. Response bodies are drained by default — undici's connection
    // pool stalls new requests when unread responses pile up. Pass
    // {drain:false} to keep the body (e.g. SSE).
    const raw = async (method, p, { body, headers = {}, creds: useCreds = true, drain = true } = {}) => {
        const r = await fetch(base + p, {
            method,
            redirect: 'manual',
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(useCreds ? creds() : {}),
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (drain) await r.arrayBuffer().catch(() => {});
        return r;
    };

    // /api/* request parsed as JSON (falls back to raw text).
    const call = async (method, p, body, opts) => {
        const r = await raw(method, '/api/' + p, { body, ...opts, drain: false });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: r.status, json, headers: r.headers };
    };

    return {
        base,
        raw,
        get token() { return token; },
        get cookie() { return cookie; },
        useCreds(t, c) { token = t; cookie = c; },
        post: (p, b, o) => call('POST', p, b ?? {}, o),
        get: (p, o) => call('GET', p, undefined, o),
        async login(handle, password = 'changeme') {
            const r = await call('POST', 'login', { handle, password }, { creds: false });
            if (r.status !== 200) throw new Error(`login ${handle}: ${r.status} ${JSON.stringify(r.json)}`);
            token = r.json.token;
            cookie = (r.headers.getSetCookie()[0] || '').split(';')[0];
            return r;
        },
        async stop() {
            await new Promise(resolve => {
                child.removeAllListeners('exit');
                if (child.exitCode !== null) return resolve();
                child.on('exit', resolve);
                child.kill('SIGTERM');
            });
        },
    };
}

/**
 * Minimal OpenAI-compatible API stand-in. Serves GET /v1/models and accepts
 * POST /v1/chat/completions, replying with `reply`. Records every request so
 * tests can assert on the prompt generateReply assembled.
 */
export async function mockLLM(reply = 'Mock reply.') {
    const requests = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, body });
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET' && req.url.endsWith('/models'))
                return res.end(JSON.stringify({ data: [{ id: 'mock-13b' }, { id: 'mock-7b' }] }));
            res.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: reply } }],
                usage: { prompt_tokens: 42, completion_tokens: 3 },
            }));
        });
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${srv.address().port}`,
        requests,
        close: () => new Promise(resolve => srv.close(resolve)),
    };
}

/** Build a valid PNG buffer embedding `card` as a base64 'chara' tEXt chunk. */
export function pngCardBuffer(card) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type, data) => Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })(),
        Buffer.from(type, 'ascii'), data, Buffer.alloc(4),
    ]);
    const text = Buffer.concat([Buffer.from('chara\0', 'ascii'), Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'ascii')]);
    return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', text), chunk('IEND', Buffer.alloc(0))]);
}

/** Raw GET with an un-normalized path (fetch() collapses '..'), for traversal checks. */
export function rawPath(base, p, headers = {}) {
    const { hostname, port } = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path: p, headers }, res => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Poll `fn` until it returns truthy or ~4s elapse. For async fan-out (SSE/AI). */
export async function until(fn, what = 'condition') {
    const deadline = Date.now() + 4000;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await new Promise(r => setTimeout(r, 60));
    }
    throw new Error(`timed out waiting for ${what}`);
}
