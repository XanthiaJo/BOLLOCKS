# BOLLOCKS live-server (.92) access notes

Local, gitignored notes on what this machine can reach on the live host
(192.168.0.92). Verified 2026-11-22.

## SSH — `ssh bollocks`

`~/.ssh/config` maps `bollocks` → `cline@192.168.0.92`, key
`~/.ssh/bollocks-server`. The key is `restrict` + forced command
(`/opt/ai-stack/bollocks-admin/bollocksctl.sh`), so **every SSH call is one
of the wrapper's ops** — no shell, no scp/sftp, no port forwarding, no TTY.
All calls are logged server-side to
`/opt/ai-stack/bollocks-admin/bollocksctl.log`.

### Ops (complete list, per Blake + probing)

| Op | Effect |
|---|---|
| `status` | Container state (`bollocks Up … 0.0.0.0:8100->8100/tcp`) |
| `logs [n]` | Tail container logs (max 5000 lines) |
| `restart` | Compose restart — **live action, bounces the server (~10s)** |
| `deploy <ref>` | Fetch repo → `reset --hard <ref>` → rsync to live dir → rebuild + restart → tail boot log. Volume/DB untouched by deploys |
| `diff <ref>` | Preview which files a `deploy <ref>` would change (read-only) |

Careful: unknown ops print `bollocksctl: unknown op: X` harmlessly, but real
ops (`restart`, `deploy`) execute immediately with no confirmation. Don't
probe op names blindly.

## HTTP API

The live app is reachable at `http://192.168.0.92:8100`. Verified:
`GET /api/version` → `{"version":"0.2.0-beta.1","sha":null}`.

Authenticated endpoints need a session token — pass it as
`Authorization: Bearer <token>` (same `mp_token` the frontend stores). The
maintenance scripts take it via env:

```bash
LIVE_URL=http://192.168.0.92:8100 LIVE_TOKEN=<token> node scripts/backfill-triggers.mjs
```

Token comes from logging in on the live site (or `POST /api/login`).

## DB access — NOT available

There is **no way to read `data/app.db` directly** from this machine:

- No `db`/`sql`/`dump`-style op in `bollocksctl` (the 5 ops above are all)
- scp/sftp blocked by `restrict`; sshfs needs sftp → also out
- The DB lives in the container's data volume; nothing exposes it over TCP

### If live-DB access is needed, options are:

1. **HTTP API + `LIVE_TOKEN`** — works today; covers everything the API
   exposes, no server changes needed.
2. **New wrapper op** — e.g. a `dbdump` op in `bollocksctl.sh` that runs
   `sqlite3 .dump` (or copies the volume's `app.db`) and prints it on stdout,
   so `ssh bollocks dbdump > app.db` works. Needs Blake to edit the wrapper.
3. **Dedicated SSH op to fetch the file** — e.g. an op that drops a copy of
   `app.db` into a dir reachable some other way. Same story: server-side change.
