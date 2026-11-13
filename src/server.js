import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { db, seed, migrateProfiles, migrateSchema } from './db.js';
import { send, auth } from './lib/util.js';
import { PUB } from './lib/files.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import memoriesRoutes from './routes/memories.js';
import worldRoutes from './routes/world.js';
import cardsRoutes from './routes/cards.js';
import roomsRoutes from './routes/rooms.js';
import profilesRoutes from './routes/profiles.js';
import chatRoutes from './routes/chat.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(PUB, '..', 'package.json'), 'utf8')).version;
// Commit the deploy pulled — .git exists on checkout-style deploys; otherwise
// a container build can pass GIT_SHA explicitly.
const SHA = process.env.GIT_SHA || (() => { try { return execSync('git rev-parse --short HEAD', { cwd: path.join(PUB, '..') }).toString().trim(); } catch { return ''; } })();
const PORT = Number(process.env.PORT || 8100);
migrateSchema();
migrateProfiles();
if (process.env.BOLLOCKS_SEED !== '0') seed();

// Route tables live in src/routes/*.js — merged here, last wins.
const router = {
    ...authRoutes,
    ...usersRoutes,
    ...memoriesRoutes,
    ...worldRoutes,
    ...cardsRoutes,
    ...roomsRoutes,
    ...profilesRoutes,
    ...chatRoutes,
    'GET /api/version': async (req, res) => send(res, 200, { version: VERSION, sha: SHA || null }),
};

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const user = auth(req);
    // Unauthenticated: /api/* is off-limits except login/logout; static files
    // redirect to the login page below (the session cookie authenticates them).
    const firstUser = key === 'POST /api/register' && !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (!user && url.pathname.startsWith('/api/') && key !== 'POST /api/login' && key !== 'GET /api/logout' && key !== 'GET /api/version' && !firstUser)
        return send(res, 401, { error: 'auth required' });
    if (router[key]) {
        try { return await router[key](req, res, user); }
        catch (e) { console.error(`[${key}]`, e); return send(res, 500, { error: String(e?.message || e) }); }
    }
    // static — the login page is the only file served without a session
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
    if (fs.existsSync(file) && file.startsWith(PUB + path.sep)) {
        if (!user && path.basename(file) !== 'login.html') {
            res.writeHead(302, { Location: '/login.html' });
            return res.end();
        }
        const ext = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain';
        res.writeHead(200, { 'Content-Type': ext });
        return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`[rp] listening on :${PORT}`));
