// Permission helpers shared by route handlers.
import { db } from '../db.js';

export const roomOwner = id => db.prepare('SELECT owner_users_id_fk AS o FROM rooms WHERE rooms_id_pk=?').get(id)?.o;
export const roomOwnerOnly = (roomId, u) => roomOwner(roomId) === u.users_id_pk;
// u sits in the room (any of their cards is seated) or owns it.
export const roomMember = (roomId, u) => !!u && (roomOwnerOnly(roomId, u) ||
    !!db.prepare(`SELECT 1 FROM room_members rm JOIN cards c ON c.cards_id_pk=rm.cards_id_fk
        WHERE rm.rooms_id_fk=? AND c.owner_users_id_fk=?`)
        .get(roomId, u.users_id_pk));
// Memory lives in at least one room u sits in.
export const memoryShared = (id, u) => db.prepare('SELECT rooms_id_fk AS r FROM room_memories WHERE memories_id_fk=?')
    .all(id).some(x => roomMember(x.r, u));
// First registered user is the site admin (user admin lives on the Connection page).
export const isAdmin = u => !!u && u.users_id_pk === db.prepare('SELECT MIN(users_id_pk) m FROM users').get().m;
// Entry is in a book u owns, or attached to no book at all.
export const worldEntryOk = (id, u) => !!u && (!db.prepare('SELECT 1 FROM book_entries WHERE world_entries_id_fk=?').get(id) ||
    !!db.prepare(`SELECT 1 FROM book_entries be JOIN world_books wb ON wb.world_books_id_pk=be.world_books_id_fk
        WHERE be.world_entries_id_fk=? AND wb.owner_users_id_fk=?`).get(id, u.users_id_pk));
