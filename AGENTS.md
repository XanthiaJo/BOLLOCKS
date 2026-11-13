# AGENTS

Guidance for coding agents working in this repository.

## Project overview

BOLLOCKS (Bots' Own Lore Logic & Open Chat Konversation System) is a multiplayer group-chat server that mixes AI characters and humans. The server owns all state (SQLite + the LLM connection) and exposes a thin HTTP + SSE API consumed by plain HTML/JS pages. There is no build step and no framework anywhere.

## Where things live (file map)

### `src/` — Node.js backend (ES modules)

| File | Purpose | Key exports / sections |
|---|---|---|
| `server.js` | The entire HTTP layer: route table, auth, SSE fan-out, static file serving | `router` object (`"METHOD /path"` → handler); `auth(req)`; `push(roomId, evt)` SSE broadcast; `roomOwnerOnly()` guard; request-gate + static-file section at the bottom of the file |
| `db.js` | SQLite (`node:sqlite` `DatabaseSync`) at `data/app.db`: schema, migrations, auth/session helpers, seed data | `db` (shared handle); `hash`/`verify` (scrypt); `createUser`/`login`/`userForToken`; `activeProfile(userId)`; `MSG_SQL` (canonical messages SELECT); `migrateSchema()`; `migrateProfiles()`; `seed()` |
| `generate.js` | LLM integration + prompt assembly (server-side only; API keys never reach clients) | `generateReply(roomId, card)` — builds system prompt (card fields + world entries + memories + history), calls `{apiUrl}/chat/completions`; `maybeSummarize(roomId)` — smart-memory extraction; `memProfileFor(room)`; `genStats` (per-room last-request stats for the prompt inspector) |
| `pngcard.js` | SillyTavern character-card import | `extractCardJson(pngBuf)` (tEXt `chara` chunk); `normalizeCard(raw)` (ST v1/v2 → our columns) |

### `public/` — frontend, static files served by `server.js` (no bundler)

| File | Purpose |
|---|---|
| `login.html` | Login page — the ONLY file served without a session. Self-contained (inline CSS/JS); stores token in `localStorage.mp_token`, redirects to `/` |
| `index.html` + `app.js` | Chat page: room list, messages, members sidebar, prompt-token inspector, SSE live updates |
| `characters.html` | Card list + editor, avatar upload with in-browser crop |
| `world.html` | Lorebook list (create/delete/link-to-room, ST JSON import) |
| `world-edit.html` | Entry editor for one book (`?id=<book>`): keys, secondary keys, content, constant/enabled, order |
| `memories.html` | Memory browser/editor: filter by card/room, triggers, move between card↔room scope |
| `connection.html` | API profiles (OpenAI-compatible endpoints: url/model/key/headers/context), memory profiles, user admin |
| `layout.js` | Shared shell injected into every page: top nav + sidebar toggles + version badge. Also `mpOpenEditor`/`mpCloseEditor`/`mpFlashSaved` and `activateProf` helpers |
| `layout.css` | Shared styles for the shell and pages |

### Everything else

| Path | Purpose |
|---|---|
| `data/` | Runtime state, gitignored: `app.db` (SQLite), `cards/*.png` (avatars), `bg/*.png` (room backgrounds). Never commit it |
| `scripts/` | Node ESM maintenance scripts run manually: `backfill-triggers.mjs` (LLM-fill memory trigger keywords on a live server), `pull-st-connection.mjs` (import a SillyTavern host's API connection over ssh) |
| `docs/memories.md` | Design doc for the memory system (kinds, ownership rules, extraction flow) |
| `docs/tests.md` | Checklist of exactly what the test suite covers + known gaps it has surfaced |
| `test/` | `node:test` suites run by `npm test`: `api-contract.test.js` (static frontend↔route checks), `upgrade.test.js` (migration/upgrade), `functional.test.js` (full API behavior), `pngcard.test.js` (card parser units), `helpers.js` (shared `boot()`/`mockLLM()` harness) |
| `.github/workflows/` | `pr-autofill.yml` (commit-list above PR body), `pr-checks.yml` (lint + `npm test`), `beta.yml`/`release.yml` (manual releases via `Box-of-Dragons/StructuredChaos`) |

## Request lifecycle (server.js)

1. `auth(req)` resolves the session from, in order: `Authorization: Bearer` header → `mp_token` HttpOnly cookie (set by `/api/login`) → `?token=` query param (for `EventSource`). Returns the user row or undefined.
2. **API gate:** unauthenticated `/api/*` → 401, except `POST /api/login`, `GET /api/logout`, `GET /api/version`, and `POST /api/register` when zero users exist (first-run bootstrap).
3. `router[key]` dispatch; handlers get `(req, res, user)`. JSON via `send(res, code, obj)`. Body via `readBody(req)`.
4. **Static gate:** no session → every file except `login.html` redirects (302) to `/login.html`. Files are confined to `PUB` via `file.startsWith(PUB + path.sep)`.
5. SSE: `GET /api/stream?room=N` registers `res` in `streams`; `push()` fans `data:` events to a room. Event types: `{type:'message'}`, `{type:'delete'}`.

Route-handler conventions: updates go through `/api/<thing>/update|delete` POST endpoints (no PUT/DELETE methods); permission checks use `roomOwnerOnly(rid, u)` or `card.owner_users_id_fk === u.users_id_pk`; the `u` arg may be undefined for public routes — don't dereference it unguarded.

## Data model

Canonical column naming: `<table>_<col>_pk` for primary keys, `<referenced_table>_<col>_fk` for foreign keys (e.g. `rooms_id_pk`, `owner_users_id_fk`). The `CREATE TABLE` block at the top of `db.js` uses legacy short names — `migrateSchema()`'s `REN` map renames them on startup, so always write queries against the pk/fk names.

Core tables:

- `users` / `sessions` — accounts; `sessions.sessions_token_pk` is the bearer/cookie token.
- `rooms` — chats; carries `ai_trigger` (manual/all/named/roundrobin), `bg`, `max_context`, `mem_profiles_id_fk`, `owner_users_id_fk`, `mem_last_messages_id`, `mem_refresh_count`.
- `cards` — character sheets (ST v2 field parity); `is_persona=1` marks a user's human persona; `owner_users_id_fk` owns it; `api_profiles_id_fk` may pin a generation profile.
- `members` + `room_members` — a `members` row wraps one card (adds `talkativeness`); `room_members` joins members into rooms. Humans sit in rooms via their persona card.
- `messages` — chat log per room (`cards_id_fk` NULL = system line); use `MSG_SQL` for the standard SELECT (adds `id`, `name`, `kind` ∈ say/ai/sys).
- `world_books` → `book_entries` → `world_entries` → `world_entry_keys` (primary/secondary keyword rows); `room_books` links at most one book to a room.
- `memories` (+`room_memories`, +`memory_cards`) — `origin='user'` permanent vs `origin='smart'` auto-extracted; `triggers` keyword-gate injection; `type` ∈ fact/event/relationship/preference.
- `api_profiles` — per-user OpenAI-compatible connections (`active` flag, `headers` JSON, `context_size`, `max_response`, `strip_prefix`, `key`).
- `mem_profiles` — named memory-setting presets a room follows (`mem_*` columns; see `MEM_PROFILE_FIELDS` in `generate.js`).

**Schema changes** go in `migrateSchema()` in `db.js`: additive `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info` checks, or table rebuilds for FK changes; one-time data fixes are gated by `PRAGMA user_version` bumps. Never edit the top `CREATE TABLE` block alone — migrations must bring existing DBs along.

## Generation pipeline (generate.js)

- `generateReply(roomId, card)`: picks the connection (card's `api_profiles_id_fk`, else card-owner's active profile), applies `{{char}}`/`{{user}}` macros, injects keyword-triggered world entries + trigger-gated memories (budget-capped, chars/4 estimate), trims history to the smaller of room `max_context` / profile `context_size` (keeps greeting + tail), posts to `/chat/completions`, strips a leading `Name:` tag, records `genStats[roomId]`.
- `maybeSummarize(roomId)`: if the room's memory profile has `auto_mem`, every `mem_every` messages (or context-threshold hit) it asks the LLM to distill recent lines into typed bullet memories, enforces per-type and total caps, and can autotune the injection budget.
- Who replies: `POST /api/say` in `server.js` applies the room's `ai_trigger` policy (talkativeness roll per AI member) — generation itself is always server-side.

## Frontend conventions

- Plain browser JS in each page's inline `<script>` + `app.js` for chat. No modules, no imports — pages share helpers via `layout.js` globals and copy this boilerplate:
  ```js
  const H=()=>({'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.mp_token||'')});
  const api=(p,b)=>fetch(`/api/${p}`,{method:'POST',headers:H(),body:JSON.stringify(b||{})}).then(r=>r.status===401?location='/login.html':r.json());
  const get=p=>fetch(`/api/${p}`,{headers:H()}).then(r=>r.status===401?location='/login.html':r.json());
  ```
  Keep that pattern (including the 401→login redirect) when adding pages.
- `localStorage` keys: `mp_token` (session), `mp_room` (last room).
- Images/SSE can't send headers — `/api/avatar`, `/api/roombg` authenticate via the `mp_token` cookie; `EventSource` uses `?token=`. Don't re-add public exemptions for them.
- Element IDs like `$('msgs')`, `$('members')` come from each page's markup; the `$` helper is defined per-page.
- Logout: nav link → `GET /api/logout` (deletes session server-side + clears cookie + redirects); the click handler clears `localStorage.mp_token`.

## Tech stack and runtime

- **Node.js ESM** throughout (`import`/`export`, `"type": "module"`). Prefer `node:` specifiers for built-ins.
- **No framework / no bundler.** Backend uses Node's built-in `http`; frontend is static assets served by the app.
- **Database:** SQLite via `node:sqlite` (`DatabaseSync`), file `data/app.db`.
- **Realtime:** Server-Sent Events (`/api/stream`).
- **LLM API:** OpenAI-compatible `chat/completions` with per-profile connection settings.

## Local development

```bash
npm install
npm start      # runs: node src/server.js (default PORT 8100, override with env PORT)
               # data dir defaults to ./data; override with env BOLLOCKS_DATA
               # (e.g. point at an sshfs mount to share another host's live DB)
npm run lint   # ESLint checks
npm run lint:fix
```

Seeded dev users (fresh DB, `seed()`): `creamms`, `karima`, `blake`, `entropy75` — all password `changeme`. Skip seeding with `BOLLOCKS_SEED=0`; the first `POST /api/register` then bootstraps the initial user.

## Code conventions

- Keep changes consistent with surrounding code (module style, naming, routing patterns, SQL style).
- Use Node built-in modules via `node:` imports where practical.
- Backend routes follow the existing pattern in `src/server.js` (`router` map of `"METHOD /path"` handlers returning JSON via `send()`).
- Database changes should fit the existing migration approach in `src/db.js` (additive/evolving schema handled in code) and preserve established column naming patterns where applicable.
- Frontend is frameworkless browser JS; avoid introducing a build step unless explicitly requested.

## Commits, branches, and PRs

- Use **Conventional Commits** where practical (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`, `test:`, `perf:`, `style:`; `!`/`BREAKING` for breaking changes). CI/release automation relies on commit conventions.
- **Never push directly to `dev`, `beta`, or `master`.** All changes go on a feature branch and land via PR — even docs or one-line fixes. Branch flow and release automation are coordinated with `StructuredChaos` workflows (`dev` → beta/release processes; see workflow files). Do not change release/beta workflow behavior without understanding that integration.
- PRs: `pr-autofill.yml` refreshes an autofilled commit list above any manual PR description (without changing the PR title); `pr-checks.yml` runs lint and `npm test` on PR updates. Ensure both pass before opening/updating a PR.

## Validation

- `npm run lint` for static checks; `npm test` (`node --test`, no extra deps) runs `test/`:
  - `api-contract.test.js` — every `api()`/`get()` call in `public/` must hit an existing route, and every field it sends must be read by that handler (`b.<field>`). Add a field to the handler or drop it from the page; don't send dead fields.
  - `upgrade.test.js` — populates a DB through the API using the base branch plus `origin/dev`/`beta`/`master` (override with `UPGRADE_FROM="ref ref"`), boots this checkout on it twice, and checks no rows/links were lost, `integrity_check`/`foreign_key_check` are clean, no FK points at a renamed column, and the second boot changes nothing. Run `git fetch origin dev beta master` first locally. When you add a table or link, extend `populate()` so it gets covered.
  - `functional.test.js` — full API surface end-to-end against a real spawned server + a mock OpenAI endpoint: auth/session transports, request gating, rooms/members permissions, cards, memories, world, profiles, SSE fan-out, generation + trigger policies.
  - `pngcard.test.js` — unit tests for `extractCardJson`/`normalizeCard`.
  - New tests should reuse the harness in `test/helpers.js` (`boot` a real server on an isolated `BOLLOCKS_DATA`, `mockLLM`, `pngCardBuffer`, `rawPath`, `until`). docs/tests.md lists what's covered and the known gaps found so far.
- For behavior changes, manually verify the affected API/pages against a local server when feasible (e.g. `PORT=8123 node src/server.js` + `curl`; auth flows can be exercised with `-c`/`-b` cookie jars).
