// Pulls the ST host's OpenRouter connection into every rp-server user's
// settings. Run: node scripts/pull-st-connection.mjs [handle]
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDLE = process.argv[2] || 'admin';
const stRead = f =>
    execFileSync('ssh', ['-o', 'BatchMode=yes', 'elitedesk-stctl', `read data/${HANDLE}/${f}`],
        { encoding: 'utf8' });

const secrets = JSON.parse(stRead('secrets.json'));
const settings = JSON.parse(stRead('settings.json'));
const oai = settings.oai_settings || {};

// ST secrets are arrays of {value, active} — take the active entry.
const unwrap = v => Array.isArray(v) ? (v.find(e => e.active) || v[0])?.value : v;

const conn = {
    apiUrl: 'https://openrouter.ai/api/v1',
    model: oai.openrouter_model || 'z-ai/glm-5.1',
    key: unwrap(secrets.api_key_openrouter),
};
if (!conn.key) { console.error('no api_key_openrouter in ST secrets'); process.exit(1); }

const db = new DatabaseSync(path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'app.db'));
const r = db.prepare('UPDATE users SET settings=?').run(JSON.stringify(conn));
console.log(`wired ${r.changes} user(s) → ${conn.apiUrl} model ${conn.model}`);
