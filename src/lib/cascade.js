// Delete cascades are route-owned: explicit, ordered DELETEs. The DDL's
// ON DELETE CASCADE clauses are a safety net, not the mechanism — FK
// actions can't reach through junctions anyway (e.g. room → memories
// goes via room_memories), and a partial chain just means a 500.
import { db } from '../db.js';

export function deleteRoomCascade(rid) {
    const memIds = 'SELECT memories_id_fk FROM room_memories WHERE rooms_id_fk=?';
    db.prepare('DELETE FROM prompt_logs WHERE rooms_id_fk=?').run(rid);
    db.prepare('UPDATE messages SET supersedes=NULL WHERE rooms_id_fk=?').run(rid);
    db.prepare('DELETE FROM messages WHERE rooms_id_fk=?').run(rid);
    db.prepare('DELETE FROM room_members WHERE rooms_id_fk=?').run(rid);
    db.prepare(`DELETE FROM memory_cards WHERE memories_id_fk IN (${memIds})`).run(rid);
    db.prepare(`DELETE FROM memory_triggers WHERE memories_id_fk IN (${memIds})`).run(rid);
    db.prepare(`DELETE FROM memories WHERE memories_id_pk IN (${memIds})`).run(rid);
    db.prepare('DELETE FROM room_memories WHERE rooms_id_fk=?').run(rid);
    db.prepare('DELETE FROM room_books WHERE rooms_id_fk=?').run(rid);
    db.prepare('DELETE FROM rooms WHERE rooms_id_pk=?').run(rid);
}

export function deleteCardCascade(cid) {
    db.prepare('DELETE FROM prompt_logs WHERE cards_id_fk=?').run(cid);
    db.prepare('UPDATE messages SET supersedes=NULL WHERE cards_id_fk=? OR supersedes IN (SELECT messages_id_pk FROM messages WHERE cards_id_fk=?)').run(cid, cid);
    db.prepare('DELETE FROM messages WHERE cards_id_fk=?').run(cid);
    db.prepare('DELETE FROM room_members WHERE cards_id_fk=?').run(cid);
    db.prepare('DELETE FROM memory_cards WHERE cards_id_fk=?').run(cid);
    db.prepare('DELETE FROM cards WHERE cards_id_pk=?').run(cid);
}

export function deleteUserCascade(uid) {
    for (const r of db.prepare('SELECT rooms_id_pk AS id FROM rooms WHERE owner_users_id_fk=?').all(uid)) deleteRoomCascade(r.id);
    for (const c of db.prepare('SELECT cards_id_pk AS id FROM cards WHERE owner_users_id_fk=?').all(uid)) deleteCardCascade(c.id);
    const books = 'SELECT world_books_id_pk FROM world_books WHERE owner_users_id_fk=?';
    const entries = `SELECT world_entries_id_fk FROM book_entries WHERE world_books_id_fk IN (${books})`;
    db.prepare(`DELETE FROM world_entry_keys WHERE world_entries_id_fk IN (${entries})`).run(uid);
    db.prepare(`DELETE FROM world_entries WHERE world_entries_id_pk IN (${entries})`).run(uid);
    db.prepare(`DELETE FROM book_entries WHERE world_books_id_fk IN (${books})`).run(uid);
    db.prepare(`DELETE FROM room_books WHERE world_books_id_fk IN (${books})`).run(uid);
    db.prepare('DELETE FROM world_books WHERE owner_users_id_fk=?').run(uid);
    // Profiles: rooms following the user's mem profiles fall back to none;
    // any card still pinning an api profile (any owner) is unpinned first.
    db.prepare('UPDATE rooms SET mem_profiles_id_fk=NULL WHERE mem_profiles_id_fk IN (SELECT mem_profiles_id_pk FROM mem_profiles WHERE users_id_fk=?)').run(uid);
    db.prepare('UPDATE cards SET api_profiles_id_fk=NULL WHERE api_profiles_id_fk IN (SELECT api_profiles_id_pk FROM api_profiles WHERE users_id_fk=?)').run(uid);
    db.prepare('UPDATE mem_profiles SET mem_extraction_profile_id=0 WHERE mem_extraction_profile_id IN (SELECT api_profiles_id_pk FROM api_profiles WHERE users_id_fk=?)').run(uid);
    db.prepare('DELETE FROM prompt_profiles WHERE users_id_fk=?').run(uid);
    db.prepare('DELETE FROM mem_profiles WHERE users_id_fk=?').run(uid);
    db.prepare('DELETE FROM api_profiles WHERE users_id_fk=?').run(uid);
    db.prepare('DELETE FROM sessions WHERE users_id_fk=?').run(uid);
    db.prepare('DELETE FROM users WHERE users_id_pk=?').run(uid);
}
