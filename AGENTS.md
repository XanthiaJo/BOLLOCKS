# AGENTS

Guidance for coding agents working in this repository.

## Project overview

BOLLOCKS (Bots' Own Lore Logic & Open Chat Konversation System) is a multiplayer group-chat server that mixes AI characters and humans. The server owns all state (SQLite + the LLM connection) and exposes a thin HTTP + SSE API consumed by plain HTML/JS pages. There is no build step and no framework anywhere.

## Where things live (file map)

### `src/` — Node.js backend (ES modules)

| File | Purpose | Key exports / sections |
|---|---|---|
| `server.js` | Thin HTTP shell: merges route tables, request gates, static file serving | `router` merge of `src/routes/*`; unauthenticated-API 401 gate; static-file gate |
| `routes/` | Route tables by domain, each `export default { 'METHOD /path': handler }`: `auth` (login/logout/register), `users` (me/persona/user admin), `memories`, `world` (lorebook), `cards`, `rooms` (rooms/members/backgrounds/room view), `profiles` (api+mem profiles, models), `chat` (stream/say/generate/messages/genstats) | |
| `lib/util.js` | Request/response helpers | `send`, `readBody`, `cookieToken`, `auth(req)` |
| `lib/access.js` | Permission helpers for route handlers | `roomOwnerOnly`, `roomMember`, `memoryShared`, `isAdmin`, `worldEntryOk` |
| `lib/sse.js` | Server-Sent Events fan-out | `streams` map; `push(roomId, evt)` |
| `lib/files.js` | Filesystem locations | `PUB`, `CARDS_DIR`, `BG_DIR` (created on import) |
| `db.js` | SQLite (`node:sqlite` `DatabaseSync`) at `data/app.db`: schema, migrations, auth/session helpers, seed data | `db` (shared handle); `hash`/`verify` (scrypt); `createUser`/`login`/`userForToken`; `activeProfile(userId)`; `MSG_SQL` (canonical messages SELECT); `migrateSchema()`; `migrateProfiles()`; `seed()` |
| `generate.js` | LLM integration + prompt assembly (server-side only; API keys never reach clients) | `generateReply(roomId, card)` — builds system prompt (card fields + world entries + memories + history), calls `{apiUrl}/chat/completions`; `maybeSummarize(roomId)` — smart-memory extraction; `memProfileFor(room)`; `genStats` (per-room last-request stats for the prompt inspector) |
| `lib/pngcard.js` | SillyTavern character-card import | `extractCardJson(pngBuf)` (tEXt `chara` chunk); `normalizeCard(raw)` (ST v1/v2 → our columns) |

### `public/` — frontend, static files served by `server.js` (no bundler)

| File | Purpose |
|---|---|
| `login.html` | Login page — the ONLY file served without a session. Self-contained (inline CSS/JS); stores token in `localStorage.mp_token`, redirects to `/` |
| `index.html` + `js/app.js` | Chat page: room list, messages, members sidebar, prompt-token inspector, SSE live updates |
| `characters.html` + `js/characters.js` | Card list + editor, avatar upload with in-browser crop |
| `world.html` | Lorebooks — single page: sidebar picks a book then its entries (`?id=<book>` deep-links a book); main edits the selected thing (book rename/create/ST import, or entry keys/secondary/content/constant/enabled/order). Link a book to a room in chat settings |
| `memories.html` + `js/memories.js` | Memory browser: Permanent/Smart tabs, sidebar scope picker (room-shared or per-character; Smart stays room-scoped for now). `memsettings.html` + `js/memsettings.js` | Smart memory page (nav: "Smart memory"): profile list in sidebar → editor panel (`class="panel settings"` accordions). `js/memprofiles.js` | Shared profile-editor code loaded by both pages — it ends by calling the page's own `load()`. All styles live in `css/layout.css` |
| `connection.html` + `js/connection.js` | Profiles page, tabbed: Connection (API profiles — OpenAI-compatible url/model/key/headers/context) and Injection (prompt_profiles — prompt-assembly presets incl. prompt order) |
| `js/layout.js` | Shared shell injected into every page: top nav + sidebar toggles + version badge. Helpers: `mpOpenEditor`/`mpCloseEditor`/`mpFlashSaved`, `activateProf`, and `rprofRow()` — the single builder for sidebar picker rows (`.rprof` in layout.css is its style) |
| `css/layout.css` | Shared styles for the shell and pages |

### Everything else

| Path | Purpose |
|---|---|
| `data/` | Runtime state, gitignored: `app.db` (SQLite), `cards/*.png` (avatars), `bg/*.png` (room backgrounds). Never commit it |
| `scripts/` | Node ESM maintenance scripts run manually: `backfill-triggers.mjs` (LLM-fill memory trigger keywords on a live server), `pull-st-connection.mjs` (import a SillyTavern host's API connection over ssh) |
| `docs/memories.md` | Design doc for the memory system (kinds, ownership rules, extraction flow) |
| `docs/tests.md` | Checklist of exactly what the test suite covers + known gaps it has surfaced |
| `test/` | `node:test` suites run by `npm test`: `api-contract.test.js` (static frontend↔route checks), `upgrade.test.js` (migration/upgrade), one file per API domain (`auth`, `profile`, `rooms`, `access`, `cards`, `messages`, `world`, `memories`, `profiles`, `generate`, `users`), `pngcard.test.js` (card parser units), `helpers.js` (shared `boot()`/`mockLLM()`/`pub`/`asUser` harness) |
| `.github/workflows/` | `pr-autofill.yml` (commit-list above PR body), `pr-checks.yml` (lint + `npm test`), `beta.yml`/`release.yml` (manual releases; planner vendored at `scripts/release.mjs`) |

## Request lifecycle (server.js)

1. `auth(req)` resolves the session from, in order: `Authorization: Bearer` header → `mp_token` HttpOnly cookie (set by `/api/login`) → `?token=` query param (for `EventSource`). Returns the user row or undefined.
2. **API gate:** unauthenticated `/api/*` → 401, except `POST /api/login`, `GET /api/logout`, `GET /api/version`, and `POST /api/register` when zero users exist (first-run bootstrap).
3. `router[key]` dispatch; handlers get `(req, res, user)`. JSON via `send(res, code, obj)`. Body via `readBody(req)`.
4. **Static gate:** no session → every file except `login.html` redirects (302) to `/login.html`. Files are confined to `PUB` via `file.startsWith(PUB + path.sep)`.
5. SSE: `GET /api/stream?room=N` registers `res` in `streams`; `push()` fans `data:` events to a room. Event types: `{type:'message'}`, `{type:'delete'}`.

Route-handler conventions: routes are `export default { 'METHOD /path': handler }` maps in `src/routes/<domain>.js`; updates go through `/api/<thing>/update|delete` POST endpoints (no PUT/DELETE methods). Permission helpers live in `src/access.js`: `roomOwnerOnly(rid, u)` for room-admin routes, `roomMember(rid, u)` for anything reading/posting room content, `memoryShared(id, u)` for memory mutations, `worldEntryOk(id, u)` for lorebook entries, `isAdmin(u)` for user admin (first registered user is the site admin). Object ownership uses `…_users_id_fk === u.users_id_pk`. The `u` arg may be undefined for public routes — don't dereference it unguarded.

## Data model

Canonical column naming: `<table>_<col>_pk` for primary keys, `<referenced_table>_<col>_fk` for foreign keys (e.g. `rooms_id_pk`, `owner_users_id_fk`). The `CREATE TABLE` block at the top of `db.js` uses legacy short names — `migrateSchema()`'s `REN` map renames them on startup, so always write queries against the pk/fk names.

Core tables:

- `users` / `sessions` — accounts; `sessions.sessions_token_pk` is the bearer/cookie token.
- `rooms` — chats; carries `ai_trigger` (manual/all/named/roundrobin), `bg`, `max_context`, `mem_profiles_id_fk`, `owner_users_id_fk`, `mem_last_messages_id`, `mem_refresh_count`.
- `cards` — character sheets (ST v2 field parity); `is_persona=1` marks a user's human persona; `owner_users_id_fk` owns it; `api_profiles_id_fk` may pin a generation profile.
- `room_members` — junction joining cards into rooms; holds per-room `talkativeness`. Humans sit in rooms via their persona card.
- `messages` — chat log per room (`cards_id_fk` NULL = system line); use `MSG_SQL` for the standard SELECT (adds `id`, `name`, `kind` ∈ say/ai/sys).
- `world_books` → `book_entries` → `world_entries` → `world_entry_keys` (primary/secondary keyword rows); `room_books` links at most one book to a room.
- `memories` (+`room_memories`, +`memory_cards`) — `origin='user'` permanent vs `origin='smart'` auto-extracted; `triggers` keyword-gate injection; `type` ∈ fact/event/relationship/preference.
- `prompt_logs` — per-room LLM request/response log (`kind` ∈ reply/extract; newest 50 per room) surfaced via `GET /api/promptlog`.
- `api_profiles` — per-user OpenAI-compatible connections (`active` flag, `headers` JSON, `context_size`, `max_response`, `strip_prefix`, `key`).
- `mem_profiles` — named memory-setting presets a room follows (`mem_*` columns; see `MEM_PROFILE_FIELDS` in `generate.js`).
- `prompt_profiles` — per-user injection/prompt-assembly presets (`active` flag applies to all of the user's generations; `prompt_order` JSON array of `PROMPT_BLOCKS` keys, NULL = built-in cache-optimal order; `include_time` injects a current-time/last-message-age block below `history`).

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
- `localStorage` keys: `mp_token` (session), `mp_room` (last room), `mp_entersend` (`'1'`/`'0'`, per-device "Enter key sends" — defaults off on touch devices).
- Images/SSE can't send headers — `/api/avatar`, `/api/roombg` authenticate via the `mp_token` cookie; `EventSource` uses `?token=`. Don't re-add public exemptions for them.
- Element IDs like `$('msgs')`, `$('members')` come from each page's markup; the `$` helper is defined per-page.
- **Sidebar anatomy** — every settings page declares a bare `<aside id="rsidebar"></aside>` and calls `initSidebar({tabs, sections, buttons, footer})` (layout.js); the skeleton (tabs → h3 → list → buttons → caption) exists only there. Picker rows render through `rprofRow()` and style via `.rprof` (layout.css): `sel:` is the single accent "selected" state, "in use/active" is a `.badge` — don't hand-write row HTML or per-page highlight classes.
- **Mobile (≤`--mob`px, 700)** — the breakpoint is `--mob` in `layout.css` `:root`; JS reads it (`layout.js` `mob()`). `var()` can't appear inside `@media`, so media-query literals duplicate it — keep them in sync. Every page needs `<meta name="viewport" content="width=device-width, initial-scale=1">` or the media queries silently never fire. Sidebars become overlay drawers under the nav (`.open` class, `.mp-scrim` behind); the ☰/⚙ nav toggles enforce one-open-at-a-time, and picking a `.room`/`.rprof` row auto-closes. Hover-only affordances (`.delm`, `.rbtns`) must get `display` fallbacks inside the media query or they're unreachable on touch.
- **Content area** — browsing pages share one skeleton: `.cvhead` (title left, contextual `act`/`sec` buttons right) → new-item `.panel` with `.edhead` → `#list` of `.card` rows. "Add" always means a `+ New X` action opening that form — never a permanently-open input box.
- **Editor forms** — every editor panel starts with `<div class="edhead" data-save="fn" data-cancel="fn"><h3 id="edtitle"></h3></div>`; layout.js injects the shared `[Cancel][Save]` pair (wired lazily to the named globals; call `initEdHeads(root)` after injecting form markup dynamically). Saves are explicit — never `onchange` auto-save. **In-place edits** (world entries, memories): a selected row's card swaps for the form via `class="card editing"`; preserve unsaved input across re-renders with `draftFields(ids)`/`fillFields(d)`; cancel collapses the card back. Where a blank form is the page's only content, cancel instead re-clears it.
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

Seeded dev users (fresh DB, `seed()`): `admin`, `alice`, `bob`, `carol` — all password `changeme`. Skip seeding with `BOLLOCKS_SEED=0`; the first `POST /api/register` then bootstraps the initial user. Fresh installs also get one-shot example content (`seedExamples()`): the "Wren" demo card seated in "The House", a linked lorebook, memories in each scope, and welcome messages — flagged in the `meta` table so deleted pieces never resurrect, and skipped on DBs that already have user-created cards or lorebooks.

## Code conventions

- Keep changes consistent with surrounding code (module style, naming, routing patterns, SQL style).
- **DRY where possible.** Before adding markup, styles, or helpers, check for a shared version (`layout.js`/`layout.css`, `src/lib/`, existing helpers) and extend it rather than forking a copy. When you spot duplication you aren't fixing, flag it in your reply and suggest where a shared abstraction could live — don't silently leave copies to drift.
- Use Node built-in modules via `node:` imports where practical.
- Backend routes follow the existing pattern in `src/server.js` (`router` map of `"METHOD /path"` handlers returning JSON via `send()`).
- Database changes should fit the existing migration approach in `src/db.js` (additive/evolving schema handled in code) and preserve established column naming patterns where applicable.
- Frontend is frameworkless browser JS; avoid introducing a build step unless explicitly requested.

## Commits, branches, and PRs

- Use **Conventional Commits** where practical (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`, `test:`, `perf:`, `style:`; `!`/`BREAKING` for breaking changes). CI/release automation relies on commit conventions.
- **Never push directly to `dev`, `beta`, or `master`.** All changes go on a feature branch and land via PR — even docs or one-line fixes. Release automation is fully local: `beta.yml`/`release.yml` drive `scripts/release.mjs` (`dev` → beta/release processes; see workflow files).
- PRs: `pr-autofill.yml` refreshes an autofilled commit list above any manual PR description (without changing the PR title); `pr-checks.yml` runs lint and `npm test` on PR updates. Ensure both pass before opening/updating a PR.

## Validation

- `npm run lint` for static checks; `npm test` (`node --test`, no extra deps) runs `test/`:
  - `api-contract.test.js` — every `api()`/`get()` call in `public/` must hit an existing route, and every field it sends must be read by that handler (`b.<field>`). Add a field to the handler or drop it from the page; don't send dead fields.
  - `upgrade.test.js` — populates a DB through the API using the base branch plus `origin/dev`/`beta`/`master` (override with `UPGRADE_FROM="ref ref"`), boots this checkout on it twice, and checks no rows/links were lost, `integrity_check`/`foreign_key_check` are clean, no FK points at a renamed column, and the second boot changes nothing. Run `git fetch origin dev beta master` first locally. When you add a table or link, extend `populate()` so it gets covered.
  - One functional suite per API domain (`auth`, `profile`, `rooms`, `access`, `cards`, `messages`, `world`, `memories`, `profiles`, `generate`, `users`) — each boots its own real server + a mock OpenAI endpoint where needed: auth/session transports, request gating, rooms/members permissions, cards, memories, world, profiles, SSE fan-out, generation + trigger policies.
  - `pngcard.test.js` — unit tests for `extractCardJson`/`normalizeCard`.
  - New tests should reuse the harness in `test/helpers.js` (`boot` a real server on an isolated `BOLLOCKS_DATA`, `mockLLM`, `pngCardBuffer`, `rawPath`, `until`, `pub`, `asUser`). docs/tests.md lists what's covered and the known gaps found so far.
- For behavior changes, manually verify the affected API/pages against a local server when feasible (e.g. `PORT=8123 node src/server.js` + `curl`; auth flows can be exercised with `-c`/`-b` cookie jars).
