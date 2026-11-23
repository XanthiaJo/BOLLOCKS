// HTTP request/response helpers shared by every route file.
import { db, userForToken } from '../db.js';

export const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
export const readRaw = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
export const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
// Session token may arrive as a Bearer header, the mp_token cookie (set at
// login so plain page loads are authenticated), or the ?token= SSE param.
export const cookieToken = req =>
    (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('mp_token='))?.slice(9);
export const auth = req =>
    userForToken(req.headers.authorization?.replace(/^Bearer /, '') || cookieToken(req) || new URL(req.url, 'http://x').searchParams.get('token'))
    // Dev convenience — BOLLOCKS_DEV_USER=<handle> auto-authenticates every
    // request as that user when no session is present. Never set in prod.
    || (process.env.BOLLOCKS_DEV_USER && db.prepare('SELECT *, users_id_pk AS id FROM users WHERE handle=?').get(process.env.BOLLOCKS_DEV_USER));
