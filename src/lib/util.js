// HTTP request/response helpers shared by every route file.
import { userForToken } from '../db.js';

export const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
export const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// Session token may arrive as a Bearer header, the mp_token cookie (set at
// login so plain page loads are authenticated), or the ?token= SSE param.
export const cookieToken = req =>
    (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('mp_token='))?.slice(9);
export const auth = req =>
    userForToken(req.headers.authorization?.replace(/^Bearer /, '') || cookieToken(req) || new URL(req.url, 'http://x').searchParams.get('token'));
