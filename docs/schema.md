# Schema refinement proposal

Where the database stands, what's worth changing, and in what order.
The runtime schema is mostly well-normalized — the "bonkers" impression
came from `migrateSchema()`, a ~500-line fossil record of every shape
the DB had ever had — now retired (see Stage 3): the `CREATE TABLE`
block is the baseline and `migrateSchema()` starts fresh at
`user_version` 8. Proposals below are staged by value-vs-risk.

## What's already fine

- Junction tables for every many-to-many (`room_members`, `room_memories`,
  `memory_cards`, `room_books`, `book_entries`, `world_entry_keys`) —
  composite keys, no redundant data.
- `mem_profiles` — ~18 `mem_*` settings extracted off `rooms` into a named
  profile + FK. Textbook normalization.
- `world_entry_keys` — keywords as rows, not comma strings. The pattern
  `memories.triggers` *should* have followed (see below).
- `sessions`, `messages.supersedes_messages_id_fk` self-FK, `users.handle` UNIQUE —
  all properly constrained.
- JSON blobs (`users.settings`, `api_profiles.headers`, `prompt_order`,
  `prompt_logs.request/response`, `meta` EAV) — opaque config/audit data.
  Normalizing them buys nothing; leave alone.

## Stage 1 — done

- [x] **`members` collapsed into `room_members`** (PR #90). It wrapped one
  card + `talkativeness`, making talkativeness card-global. Now the
  junction holds `(rooms_id_fk, cards_id_fk, talkativeness)` directly.
- [x] **`memories.triggers` → `memory_triggers` rows** (PR #92). The
  comma-separated column became one row per keyword. Bonus fix: the
  legacy `ADD COLUMN source` re-add was removed — it forced a full
  `memories` rebuild (FK-cascade-wiping junction rows) on every boot.

## Stage 2 — done

- [x] **Dead columns dropped** — `memories.canon`, `mem_profiles.auto_mem`,
  `world_entries.keys`/`keysecondary`/`world_books_id_fk` removed via guarded
  `DROP COLUMN` at the end of `migrateSchema()` (the junction tables carry
  the data now; canon semantics moved to "no trigger rows").
- [x] **FKs backfilled + enforced** — `PRAGMA foreign_keys=ON` at connect;
  `room_arcs` message anchors (`ON DELETE SET NULL`), `rooms.mem_profiles_id_fk`
  and `owner_users_id_fk`, `mem_profiles`' api-profile pickers rebuilt with
  real `REFERENCES`. Sentinel `0` converted to `NULL` during the rebuilds —
  `NULL` is now the "none" convention everywhere.
- [x] **Top `CREATE` block modernized** — uses canonical `*_id_pk`/`*_id_fk`
  names directly, so references are valid at creation. (Enabling FK checks
  surfaced dangling `REFERENCES rooms(id)` clauses left over from the
  legacy-name era — they only survived because enforcement was off.)

### ~~2a. `memories.triggers` → trigger rows~~ — done (PR #92)

Now a comma-separated TEXT column — a 1NF nit, and the reason trigger
matching is substring-based string surgery. Proposed:

```sql
CREATE TABLE memory_triggers (
    memories_id_fk INTEGER NOT NULL REFERENCES memories(memories_id_pk) ON DELETE CASCADE,
    word TEXT NOT NULL,
    PRIMARY KEY (memories_id_fk, word));
```

- Mirrors `world_entry_keys` exactly — the codebase already has the
  pattern, including parsing/UI conventions.
- Matching becomes a joinable set, not `INSTR(haystack, word)` per
  row — cleaner, and enables exact/phrase semantics per keyword later.
- Injection path: one extra small join in `mems()` in `generate.js`.
- Risk: low. Data migration is `INSERT SELECT id, trim(value) FROM
  memories, split-on-comma`. Triggers are only ever whole-list replaced
  via `memories/update`, so no partial-update semantics to preserve.

### ~~2b. Delete cascades~~ — resolved (PR pending)

Went the route-owned direction: `lib/cascade.js` holds ordered,
complete delete chains (`deleteRoomCascade`/`deleteCardCascade`/
`deleteUserCascade`) — FK actions can't reach through junctions anyway,
and the audit found the partial manual chains were actually *broken*:
several deletes 500ed on `FOREIGN KEY constraint failed`. FK enforcement
is now explicit (`PRAGMA foreign_keys=ON` at connect); declared cascades
stay as safety nets.

## Stage 3 — optional / cosmetic

Tracked as [#93](https://github.com/XanthiaJo/BOLLOCKS/issues/93): a
`room_state` table for extraction bookkeeping on `rooms`, and an
index audit on the junction tables.
- [x] **`migrateSchema()` consolidation** — done. The fossil record
  (every historical `*_new` rebuild, the `REN` rename map, uv-gated
  data fixes) was deleted outright: the top `CREATE TABLE` block now
  declares the live schema directly and `migrateSchema()` is a fresh
  baseline at `user_version` 8. New changes go in both places. This
  intentionally drops upgrades from pre-baseline DBs — acceptable
  because only we run this app; the old machinery is in git history.

## Explicit non-goals

- No framework/ORM, no schema versioning tool — `migrateSchema()` stays.
- No normalization of JSON config blobs (see above).
- No renaming pass over `*_id_pk`/`*_id_fk` — established convention,
  churn without gain.
