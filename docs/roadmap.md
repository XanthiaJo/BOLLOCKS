# Roadmap

Where BOLLOCKS is headed, roughly in order of "needed soonest" → "would be
nice". Directions, not commitments — reorder freely.

## User management

Today: a `users.admin` flag marks site admins (the first registered account
is backfilled as admin). Admins get an **Admin** page — everyone else
manages their own handle/email/password on the profile page.

- [x] Admin-gated account registration — the admin can create and delete
  users via the API *(2026-11-07)*
- [x] **Admin users page** — list accounts, create users, edit
  handle/email, reset passwords (old sessions revoked), delete via cascade
  *(2026-11-17)*
- [x] **Multi-admin flag** — promote/demote admins by checkbox; the last
  admin can't be demoted *(2026-11-17)*
- [ ] **Roles** — beyond the admin flag if a second tier ever proves
  useful; keep it minimal until then
- [ ] **Invite/reset links** — optional; manual account creation covers the
  private-server case for now

## Chat & room settings

Today: room settings live in the chat page's right sidebar — AI trigger,
linked world book, memory profile, context cap, background, members with
talkativeness, last saved memory, prompt-token use. Rooms are created and
renamed from the left sidebar. The room **owner** controls the
configuration; members seat their own cards and set their own characters'
talkativeness.

- [x] Per-room AI trigger modes + per-member talkativeness *(2026-11-07)*
- [x] Chat settings in the sidebar — world link, memory profile, context
  cap, background *(2026-11-07)*
- [x] Room ownership — owner controls room config; members manage their
  own characters' seats and talkativeness *(2026-11-16)*
- [ ] **Room settings panel** — a proper view for the room's configuration
  instead of an ever-growing sidebar section
- [ ] **Member management** — seat/remove humans and AI cards from one
  place, with talkativeness alongside
- [ ] **Room list polish** — unread/message counts, maybe last-activity sort

## Smart memory sections

Today: smart memories are extracted one-per-interval by a second AI, typed
(fact/event/relationship/preference) with trigger keywords, grounded
against the room's character sheets so resolved states don't linger. They
live in one room-scoped list; profiles control how/when extraction runs.

- [x] Typed smart memories with trigger keywords *(2026-11-07)*
- [x] Shared + per-character permanent memories *(2026-11-07)*
- [x] Edit + promote — edit content/type/triggers/scope on any memory,
  promote smart ↔ permanent *(2026-11-16)*
- [x] Extraction discipline — one memory per interval, typed by rules not
  defaults, grounded in member card sheets *(2026-11-16)*
- [ ] **Organize the prompt view** — show smart memories grouped by section
  (per type and per character) so it's clear what the AI is carrying into
  each generation
- [ ] **Review flow** — glance at what extraction produced, discard noise
  (edit/promote shipped; a review-focused view hasn't)
- [ ] **Dedup/merge** — collapse near-duplicate extracted facts over time
- [ ] **Scene-state memories** — temporary states ("under sanction",
  "wheel pending") that decay instead of lingering as facts (PR #99)
- [ ] **Per-character smart scope** — extraction currently writes
  room-scoped; character-scoped smart memories are the natural next step
- [ ] **Retraction/supersede** — extracted facts have no expiry; a way to
  mark a memory superseded when the world moves on (editing by hand is
  the current answer)

## Smaller items

- [x] Seeded first-run demo — users, room, character, lorebook, memories
  *(2026-11-13)*
- [x] Identicon avatars for seeded cards *(2026-11-13)*
- [x] Prompt inspector — per-section token use scaled to the actual API
  total, cut-from-history visibility, per-section and full-request JSON
  *(2026-11-17)*
- [x] Update check + admin pull-and-update in the version badge
  *(2026-11-17)*
- [ ] **Swipes** — regenerate a reply and keep alternates
- [ ] **Message edit** — for humans and AI replies
- [ ] **Notification affordances** — unread markers per room
