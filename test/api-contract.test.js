// Static contract check between the frontend and the router in src/server.js:
// every api()/get() call in public/ must hit a route that exists with the
// right method, and every field it sends must actually be read by that
// handler. Catches the "frontend sends {id}, route reads something else,
// WHERE matches nothing, returns ok:true" class of bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

// Fields the frontend sends on purpose even though the handler ignores them.
// Keep this short; every entry is a field that does nothing server-side.
const IGNORED = {};

// Index just past the bracket matching the one at `open`, skipping strings,
// template literals and comments.
function matchClose(src, open) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const stack = [];
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === ')' || c === ']' || c === '}') {
            if (stack.pop() !== c) throw new Error(`unbalanced ${c} at ${i}`);
            if (!stack.length) return i + 1;
        }
    }
    throw new Error(`no match for bracket at ${open}`);
}

function skipString(src, i) {
    const q = src[i];
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (q === '`' && src[j] === '$' && src[j + 1] === '{') { j = matchClose(src, j + 1) - 1; continue; }
        if (src[j] === q) return j;
    }
    return src.length;
}

// Split `src` at top-level commas (depth 0, outside strings).
function splitTop(src) {
    const parts = [];
    let start = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') i = skipString(src, i);
        else if (c === '(' || c === '[' || c === '{') i = matchClose(src, i) - 1;
        else if (c === ',') { parts.push(src.slice(start, i)); start = i + 1; }
    }
    parts.push(src.slice(start));
    return parts.map(s => s.trim()).filter(Boolean);
}

// Object literals appearing at the top level of an expression, e.g. both
// branches of `cond ? {a} : {b}`.
function topObjects(expr) {
    const out = [];
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === '"' || c === "'" || c === '`') i = skipString(expr, i);
        else if (c === '{') { const e = matchClose(expr, i); out.push(expr.slice(i + 1, e - 1)); i = e - 1; }
        else if (c === '(' || c === '[') i = matchClose(expr, i) - 1;
    }
    return out;
}

// Literal keys of an object body (spreads are unknown and skipped).
function objectKeys(body) {
    const keys = [];
    for (const part of splitTop(body)) {
        if (part.startsWith('...')) continue;
        const m = part.match(/^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*(?::|$)/);
        if (m) keys.push(m[1] || m[2]);
    }
    return keys;
}

function parseRouter() {
    // Route tables live in src/server.js plus every file under src/routes/.
    const files = ['src/server.js',
        ...fs.readdirSync(path.join(ROOT, 'src', 'routes')).filter(f => f.endsWith('.js')).map(f => `src/routes/${f}`)];
    const re = /^\s{4}'(GET|POST) (\/api\/[^']+)':/gm;
    const routes = new Map();
    for (const file of files) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const hits = [...src.matchAll(re)];
        hits.forEach((m, i) => {
            const body = src.slice(m.index, hits[i + 1]?.index ?? src.indexOf('\n};', m.index));
            const reads = new Set([
                ...[...body.matchAll(/\bb\.([A-Za-z_$][\w$]*)/g)].map(x => x[1]),
                ...[...body.matchAll(/\b(?:q|searchParams)\.get\(\s*['"]([^'"]+)['"]/g)].map(x => x[1]),
            ]);
            const dynamic = /\bb\[/.test(body) || /\{\s*[^}]*\}\s*=\s*b\b/.test(body);
            routes.set(`${m[1]} ${m[2]}`, { reads, dynamic });
        });
    }
    return routes;
}

// function name(...) { ... return {...} } -> keys of the returned literal.
function returnedKeys(src, fnName) {
    const m = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(src);
    if (!m) return null;
    const bodyStart = src.indexOf('{', matchClose(src, src.indexOf('(', m.index)));
    const body = src.slice(bodyStart, matchClose(src, bodyStart));
    const r = /\breturn\s*\{/.exec(body);
    if (!r) return null;
    const o = body.indexOf('{', r.index);
    return objectKeys(body.slice(o + 1, matchClose(body, o) - 1));
}

function parseCalls() {
    const calls = [];
    const files = fs.readdirSync(PUB, { recursive: true }).filter(f => /\.(html|js)$/.test(f));
    for (const f of files) {
        const src = fs.readFileSync(path.join(PUB, f), 'utf8');
        for (const m of src.matchAll(/(?<![\w$.])(api|get)\(/g)) {
            const open = m.index + m[1].length;
            let args;
            try { args = splitTop(src.slice(open + 1, matchClose(src, open) - 1)); } catch { continue; }
            const lit = args[0]?.match(/^(['"`])([^'"`]*)/);
            if (!lit) continue; // the helper definitions themselves: api=(p,b)=>...
            const raw = lit[2];
            const [p, qs = ''] = raw.split('?');
            const route = `${m[1] === 'api' ? 'POST' : 'GET'} /api/${p.replace(/\$\{.*$/, '')}`;
            const line = src.slice(0, m.index).split('\n').length;
            const fields = new Set([...qs.matchAll(/(?:^|&)([\w]+)=/g)].map(x => x[1]));
            // GET query keys may also follow a string concatenation: 'genstats?room=' + room
            for (const x of args[0].matchAll(/[?&]([\w]+)=/g)) fields.add(x[1]);
            const body = args[1];
            if (body) {
                for (const o of topObjects(body)) objectKeys(o).forEach(k => fields.add(k));
                const call = body.match(/^([A-Za-z_$][\w$]*)\(\s*\)$/);
                if (call) (returnedKeys(src, call[1]) || []).forEach(k => fields.add(k));
            }
            calls.push({ where: `public/${f}:${line}`, route, fields: [...fields] });
        }
    }
    return calls;
}

const routes = parseRouter();
const calls = parseCalls();

test('parser finds the router and the frontend calls', () => {
    assert.ok(routes.size > 40, `only ${routes.size} routes parsed`);
    assert.ok(calls.length > 40, `only ${calls.length} frontend calls parsed`);
});

test('every frontend call hits an existing route with the right method', () => {
    const missing = calls.filter(c => !routes.has(c.route)).map(c => `${c.where}: ${c.route}`);
    assert.deepEqual(missing, [], 'frontend calls routes that do not exist:\n' + missing.join('\n'));
});

test('every field the frontend sends is read by its route handler', () => {
    const problems = [];
    for (const c of calls) {
        const r = routes.get(c.route);
        if (!r || r.dynamic) continue;
        const ignored = IGNORED[c.route] || [];
        for (const f of c.fields)
            if (!r.reads.has(f) && !ignored.includes(f))
                problems.push(`${c.where}: ${c.route} sends "${f}" but the handler never reads it (reads: ${[...r.reads].join(', ') || 'nothing'})`);
    }
    assert.deepEqual(problems, [], 'frontend/route field mismatch:\n' + problems.join('\n'));
});
