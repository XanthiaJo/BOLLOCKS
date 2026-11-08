# AGENTS

Guidance for coding agents working in this repository.

## Project overview

BOLLOCKS (Bots' Own Lore Logic & Open Chat Konversation System) is a multiplayer group-chat server that mixes AI characters and humans. The server owns state (SQLite) and exposes a thin HTTP + SSE API consumed by plain HTML/JS pages.

## Repository structure

- `src/` — Node.js backend (ES modules)
  - `server.js` — built-in `node:http` server, route table, JSON API, SSE fan-out, static file serving
  - `db.js` — `node:sqlite` (`DatabaseSync`) database at `data/app.db`, schema migrations/seed helpers
  - `generate.js` — OpenAI-compatible chat/completions integration and prompt/context assembly
  - `pngcard.js` — SillyTavern character card PNG/JSON import helpers
- `public/` — frontend (no build step): HTML pages + shared `app.js`, `layout.js`, `layout.css`
- `scripts/` — maintenance/util scripts (Node ESM `.mjs`)
- `.github/workflows/` — GitHub Actions
  - `pr-autofill.yml` — fills PR title/body from conventional commits on PR open
  - `pr-checks.yml` — PR lint checks
  - `beta.yml` / `release.yml` — manual release flows (reusable workflow in `Box-of-Dragons/StructuredChaos`)
- `data/` — runtime data (gitignored): SQLite DB, imported card images, etc.
- `package.json` — ESM package (`"type": "module"`), scripts, dev dependencies

## Tech stack and runtime

- **Node.js ESM** throughout (`import`/`export`, `"type": "module"`). Prefer `node:` specifiers for built-ins.
- **No framework / no bundler.** Backend uses Node's built-in `http`; frontend is static assets served by the app.
- **Database:** SQLite via `node:sqlite` (`DatabaseSync`), file `data/app.db`. Treat `data/` as runtime state (not committed).
- **Realtime:** Server-Sent Events (`/api/stream`).
- **LLM API:** OpenAI-compatible `chat/completions` with per-profile connection settings.

## Local development

```bash
npm install
npm start      # runs: node src/server.js (default PORT 8100)
npm run lint   # ESLint checks
npm run lint:fix
```

`data/` is created/used at runtime; it is gitignored. Do not commit database files or generated card images.

## Code conventions

- Keep changes consistent with surrounding code (module style, naming, routing patterns, SQL style).
- Use Node built-in modules via `node:` imports where practical.
- Backend routes follow the existing pattern in `src/server.js` (`router` map of `"METHOD /path"` handlers returning JSON via `send()`).
- Database changes should fit the existing migration approach in `src/db.js` (additive/evolving schema handled in code) and preserve established column naming patterns where applicable.
- Frontend is frameworkless browser JS; avoid introducing a build step unless explicitly requested.

## Commits, branches, and PRs

- Use **Conventional Commits** where practical (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`, `test:`, `perf:`, `style:`; `!`/`BREAKING` for breaking changes). CI/release automation relies on commit conventions.
- Branch flow and release automation are coordinated with `StructuredChaos` workflows (`dev` → beta/release processes; see workflow files). Do not change release/beta workflow behavior without understanding that integration.
- PRs: `pr-autofill.yml` derives title/body from commits on open; `pr-checks.yml` runs lint on PR updates. Ensure `npm run lint` passes before opening/updating a PR.

## Validation

- There is no automated test suite currently. Run `npm run lint` for static checks.
- For behavior changes, manually verify the affected API/pages against a local server when feasible.
