# Schema refinement proposal

Where the database stands, what's worth changing, and in what order.
The runtime schema is mostly well-normalized — the "bonkers" impression
comes from `migrateSchema()`, a ~500-line fossil record of every shape
the DB has ever had. Proposals below are staged by value-vs-risk.

## What's already fine

- Junction tables for every many-to-many (`room_members`, `room_memories`,
  `memory_cards`, `room_books`, `book_entries`, `world_entry_keys`) —
  composite keys, no redundant data.
- `mem_profiles` — ~18 `mem_*` settings extracted off `rooms` into a named
  profile + FK. Textbook normalization.
- `world_entry_keys` — keywords as rows, not comma strings. The pattern
  `memories.triggers` *should* have followed (see below).
- `sessions`, `messages.supersedes` self-FK, `users.handle` UNIQUE —
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

## Stage 2 — worth doing

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
several deletes 500ed on `FOREIGN KEY constraint failed` under
node:sqlite's `foreign_keys=ON` default. Declared cascades stay as
safety nets.

## Stage 3 — optional / cosmetic

- **Room extraction bookkeeping** (`mem_last_messages_id`,
  `mem_refresh_count`): single-valued pointers on `rooms`, technically
  fine, but would sit more honestly in a `room_state(room_id, key, value)`
  or on `room_memories`-adjacent state. Low value either way.
- **Index audit**: junction PKs cover `(room, member)` order; queries
  filtering by the second column alone (e.g. "all rooms card X sits in")
  rely on SQLite auto-indexes. Worth a `EXPLAIN QUERY PLAN` pass on the
  hot reads; add reverse indexes only where a scan shows.
- **`migrateSchema()` consolidation**: the real readability win. Each
  table could converge via a single "current shape" rebuild guarded by
  column checks, rather than N sequential historical rebuilds
  (`members_new`, `members_new2`, `world_entries_new3`…). Bigger diff,
  mostly cosmetic — only worth it the next time a rebuild is touched.

## Explicit non-goals

- No framework/ORM, no schema versioning tool — `migrateSchema()` stays.
- No normalization of JSON config blobs (see above).
- No renaming pass over `*_id_pk`/`*_id_fk` — established convention,
  churn without gain.
