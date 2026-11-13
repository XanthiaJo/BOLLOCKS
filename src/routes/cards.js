// Character card routes: CRUD, ST import, avatar upload/serve.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from '../db.js';
import { send, readBody } from '../lib/util.js';
import { extractCardJson, normalizeCard } from '../lib/pngcard.js';
import { CARDS_DIR } from '../lib/files.js';

export default {
    'POST /api/cards/avatar': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        const card = db.prepare('SELECT owner_users_id_fk FROM cards WHERE cards_id_pk=?').get(id);
        if (!card || card.owner_users_id_fk !== u.users_id_pk) return send(res, 403, { error: 'not your card' });
        const file = `cards/${id}.png`;
        fs.writeFileSync(path.join(CARDS_DIR, `${id}.png`), Buffer.from(b.png_b64, 'base64'));
        db.prepare('UPDATE cards SET avatar=? WHERE cards_id_pk=?').run(file, id);
        send(res, 200, { ok: true, avatar: file });
    },
    'GET /api/cards': async (req, res, u) => {
        // Own cards + cards in rooms shared with the caller — a non-owner
        // shouldn't even know other characters exist.
        const cards = db.prepare(`SELECT c.*, c.cards_id_pk AS id, u.handle owner FROM cards c
            LEFT JOIN users u ON u.users_id_pk=c.owner_users_id_fk
            WHERE c.owner_users_id_fk = ? OR c.cards_id_pk IN (
                SELECT m2.cards_id_fk FROM members m2
                JOIN room_members r2 ON r2.members_id_fk=m2.members_id_pk
                JOIN room_members re ON re.rooms_id_fk = r2.rooms_id_fk
                JOIN members me ON me.members_id_pk=re.members_id_fk JOIN cards cc ON cc.cards_id_pk=me.cards_id_fk AND cc.owner_users_id_fk = ?
                WHERE m2.cards_id_fk IS NOT NULL
            ) OR (c.is_persona=1 AND c.owner_users_id_fk IN (
                SELECT c3.owner_users_id_fk FROM members m3 JOIN cards c3 ON c3.cards_id_pk=m3.cards_id_fk
                JOIN room_members r3 ON r3.members_id_fk=m3.members_id_pk
                JOIN room_members re2 ON re2.rooms_id_fk = r3.rooms_id_fk
                JOIN members me2 ON me2.members_id_pk=re2.members_id_fk
                JOIN cards cc2 ON cc2.cards_id_pk=me2.cards_id_fk AND cc2.owner_users_id_fk = ?
                WHERE c3.owner_users_id_fk IS NOT NULL
            )) ORDER BY c.name`).all(u.users_id_pk, u.users_id_pk, u.users_id_pk);
        send(res, 200, { cards });
    },
    'POST /api/cards': async (req, res, u) => {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const id = db.prepare(`INSERT INTO cards (owner_users_id_fk,name,description,personality,scenario,first_message,
            mes_example,system_prompt,post_history_instructions,tags,creator,api_profiles_id_fk) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, b.name, b.description || '', b.personality || '', b.scenario || '', b.first_message || '',
                b.mes_example || '', b.system_prompt || '', b.post_history_instructions || '',
                JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : (b.tags || [])),
                b.creator || '', b.profileId || null).lastInsertRowid;
        send(res, 200, { id });
    },
    // Import a SillyTavern card: {png_b64} for PNG cards, {card} for JSON.
    'POST /api/cards/import': async (req, res, u) => {
        const b = await readBody(req);
        let raw = null;
        let avatarPath = '';
        if (b.png_b64) {
            const png = Buffer.from(b.png_b64, 'base64');
            raw = extractCardJson(png);
            if (!raw) return send(res, 400, { error: 'no character data in PNG' });
            const dir = CARDS_DIR;
            fs.mkdirSync(dir, { recursive: true });
            avatarPath = `cards/import-${Date.now()}.png`;
            fs.writeFileSync(path.join(dir, path.basename(avatarPath)), png);
        } else if (b.card) {
            raw = typeof b.card === 'string' ? JSON.parse(b.card) : b.card;
        }
        if (!raw) return send(res, 400, { error: 'no card data supplied' });
        const c = normalizeCard(raw);
        const id = db.prepare(`INSERT INTO cards (owner_users_id_fk,name,description,personality,scenario,first_message,mes_example,
            system_prompt,post_history_instructions,alternate_greetings,tags,creator,creatorcomment,character_version,avatar,card_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(u.users_id_pk, c.name, c.description, c.personality, c.scenario, c.first_mes, c.mes_example,
                c.system_prompt, c.post_history_instructions, JSON.stringify(c.alternate_greetings),
                JSON.stringify(c.tags), c.creator, c.creatorcomment, c.character_version, avatarPath,
                JSON.stringify(raw)).lastInsertRowid;
        send(res, 200, { id, name: c.name });
    },
    // Card avatar image.
    'GET /api/avatar': (req, res) => {
        const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
        const c = db.prepare('SELECT avatar,name FROM cards WHERE cards_id_pk=?').get(id);
        const file = c?.avatar && path.join(DATA_DIR, c.avatar);
        if (!c || !c.avatar || !fs.existsSync(file)) {
            const ch = (c?.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
            const hue = [...(c?.name || '')].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="hsl(${hue},40%,30%)"/><text x="36" y="47" font-family="system-ui" font-size="34" fill="#ddd" text-anchor="middle">${ch}</text></svg>`);
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(file).pipe(res);
    },
    'POST /api/cards/update': async (req, res, u) => {
        const b = await readBody(req);
        db.prepare(`UPDATE cards SET name=COALESCE(?,name), description=COALESCE(?,description),
            personality=COALESCE(?,personality), scenario=COALESCE(?,scenario),
            first_message=COALESCE(?,first_message), mes_example=COALESCE(?,mes_example),
            system_prompt=COALESCE(?,system_prompt), post_history_instructions=COALESCE(?,post_history_instructions),
            tags=COALESCE(?,tags), creator=COALESCE(?,creator), api_profiles_id_fk=? WHERE cards_id_pk=? AND owner_users_id_fk=?`)
            .run(b.name ?? null, b.description ?? null, b.personality ?? null, b.scenario ?? null, b.first_message ?? null, b.mes_example ?? null,
                b.system_prompt ?? null, b.post_history_instructions ?? null,
                b.tags !== undefined ? JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : b.tags) : null,
                b.creator ?? null, b.profileId ?? null, b.id || b.world_books_id_pk, u.users_id_pk);
        send(res, 200, { ok: true });
    },
    'POST /api/cards/delete': async (req, res, u) => {
        const b = await readBody(req);
        const id = b.id || b.world_books_id_pk;
        db.prepare('DELETE FROM cards WHERE cards_id_pk=? AND owner_users_id_fk=?').run(id, u.users_id_pk);
        db.prepare('DELETE FROM room_members WHERE members_id_fk IN (SELECT members_id_pk FROM members WHERE cards_id_fk=?)').run(id);
            db.prepare('DELETE FROM members WHERE cards_id_fk=?').run(id);
        send(res, 200, { ok: true });
    },
};
