# Test coverage

What `npm test` (`node --test test/*.test.js`) actually covers, per file.
All tests run against real spawned servers on isolated `BOLLOCKS_DATA` dirs —
no mocking of the app itself, only of the external LLM endpoint.

## `test/api-contract.test.js` — frontend↔backend contract (static)

- [x] Parses every `api()`/`get()` call in `public/` (>40 found) and the router table in `server.js` (>40 routes)
- [x] Every frontend call hits a route that exists, with the right HTTP method
- [x] Every field the frontend sends is read by the matching handler (catches dead parameters and typos)

## `test/upgrade.test.js` — schema migrations (functional)

- [x] Fresh DB boots, populates every link table via the real API, reboots cleanly
- [x] `PRAGMA integrity_check` + `foreign_key_check` clean; no FKs pointing at renamed/missing columns
- [x] Upgrading a populated DB from `origin/dev` (and beta/master when bootable) loses zero rows
- [x] Migrations are idempotent — second boot changes neither schema nor row counts
- [x] Post-upgrade data (rooms, memory links) is still reachable through the API

## `test/functional.test.js` — API behavior end-to-end

**Authentication & sessions**

- [x] Login rejects bad credentials (401) and returns a Bearer token + `mp_token` HttpOnly cookie
- [x] All three token transports authenticate: Bearer header, cookie, `?token=` query param
- [x] Invalid tokens (header, cookie, query) are rejected
- [x] `/api/logout` deletes the session, clears the cookie, and redirects to `/login.html`
- [x] First-run `POST /api/register` is open only while zero users exist; then gated; duplicate handles 409

**Request gating**

- [x] Every page/asset (`.html`, `.js`, `.css`) redirects to `/login.html` when unauthenticated
- [x] `login.html` stays public; missing files 404
- [x] All `/api/*` routes 401 without a session — including `avatar`, `roombg`, `stream` (no exemptions)
- [x] `login`, `logout`, `version` stay public; unknown API routes 404 after auth
- [x] Path traversal (`..`, `%2e%2e`) is refused both unauthenticated and authenticated

**Profile**

- [x] Email/handle updates persist; taken handles conflict (409, case-insensitive); empty handle 400
- [x] Password change requires the current password; new password logs in; sessions survive
- [x] Persona selection reflected in `GET /api/me`

**Rooms & members**

- [x] Room creation seats the owner's persona; `is_owner` flag correct in listings
- [x] Room lists only show rooms the user sits in
- [x] Owner-only routes 403 for non-owners: rename, delete, trigger, settings, memsettings, background, world link, seating users
- [x] Membership: anyone may seat their own card; seating others' cards or users is owner-only; nonexistent card 404
- [x] Removal: non-owners may only remove their own cards; owners remove anyone
- [x] Talkativeness: members set their own, owners set any, values clamped to 0–100
- [x] Room background upload/serve/remove round-trips

**Cards & avatars**

- [x] Card CRUD; updates/deletes by non-owners are silent no-ops (card untouched)
- [x] Avatar fallback SVG; upload restricted to owner; uploaded PNG served
- [x] `cards/import` handles ST JSON and PNG (tEXt chunk); malformed PNG 400

**Messages & SSE**

- [x] `say` posts as the caller's persona (`kind:'say'`); messages appear in `/api/room`
- [x] Message delete removes and broadcasts; re-delete 404s
- [x] `/api/stream` requires auth, returns `text/event-stream`, and flushes headers on connect
- [x] `message` and `delete` events fan out to connected streams

**World / lorebook**

- [x] Book and entry CRUD; CSV key strings split into primary/secondary keys
- [x] Partial entry updates work (missing fields don't clobber); key lists replaced wholesale
- [x] ST lorebook JSON import creates book + entries + keys; empty import 400
- [x] Room linking is owner-only; book deletion cascades entries/keys/links

**Memories**

- [x] Create room-scoped and card-scoped memories; `card=-1`/`card=N` scoping
- [x] Update content/type/triggers/origin; `/api/lastmem` returns latest `origin='smart'`
- [x] `memories/move` toggles card↔room scope; delete unlinks and removes

**Connection profiles**

- [x] Profile CRUD; first profile auto-activates; activate switches exclusively
- [x] API key is never exposed by `GET /api/profiles` (`has_key` boolean only)
- [x] `/api/models` proxies the connection; bad URL → 502; missing URL → 400
- [x] Memory profile CRUD; room assignment; deletion re-points rooms at another profile

**Generation (mock OpenAI-compatible endpoint)**

- [x] `/api/generate` assembles and posts the prompt: system message, `{{char}}` macro substitution, trailing `Name:` nudge
- [x] Leading `Name:` tag stripped from the reply; message stored as `kind:'ai'`; `genstats` recorded
- [x] No AI member → 404; owner with no connection → 500 with a clear error
- [x] `ai_trigger: 'all'` fires replies after a say (talkativeness 100); `'named'` fires only when the character is mentioned

**Users**

- [x] `GET /api/users` lists seeded users; self-delete and unknown-handle delete refused (400)

## `test/pngcard.test.js` — card parser units

- [x] `extractCardJson`: tEXt `chara`, zTXt (deflate) `chara`/`ccv3`; junk/missing/garbage chunks → `null`
- [x] `normalizeCard`: v2 (`data`-wrapped) and v1 (flat) shapes; string→array tags; field defaults

## Known gaps the tests surfaced (behavior, not test bugs)

- [ ] `POST /api/register` is case-*sensitive* on `handle` (binary UNIQUE) while login is `COLLATE NOCASE` — a `FOUNDER` account can be created but never logged into. Needs a NOCASE constraint or pre-check.
- [ ] `POST /api/login` with missing fields → 500 (SQLite bind error) rather than 400.
- [ ] `GET /api/room`, `GET /api/memories`, `POST /api/memories/*`, `POST /api/messages/delete` have no room-membership or ownership checks — any logged-in user can read/edit other rooms' content.
- [ ] `POST /api/users/delete` has no admin gate — any logged-in user can delete any other user.
- [ ] `POST /api/register` while authenticated lets any user create accounts (no admin concept exists).

## Deliberately not covered

- [ ] Real LLM output — the mock endpoint covers the request/response contract deterministically; a real-model check belongs in a manual smoke script, not CI
- [ ] `maybeSummarize` smart-memory extraction (requires `auto_mem`; same mock could drive it if desired)
- [ ] Browser-side behavior (401→login redirects, localStorage) — needs a DOM; asserted indirectly via contract tests
- [ ] `scripts/` maintenance utilities (interactive, need SSH/live server)
- [ ] Theme/CSS correctness — no visual testing infrastructure

## Running

```bash
npm test                      # everything
node --test test/functional.test.js   # one file
UPGRADE_FROM=origin/beta npm test     # pin upgrade sources
```

`test/helpers.js` provides the shared harness: `boot(dataDir, env)` (spawn
server + session-keeping client), `mockLLM()`, `pngCardBuffer()`, `rawPath()`
(unnormalized paths for traversal tests), `until()` (poll for async fan-out).
