# Roadmap

Where BOLLOCKS is headed, roughly in order of "needed soonest" → "would be
nice". Directions, not commitments — reorder freely.

## User management

Today: the first registered account is the site admin; everyone manages
their own handle/email/password on the profile page. There is no admin UI
at all.

- [x] Admin-gated account registration — the admin can create and delete
  users via the API *(2026-11-07)*
- [ ] **Admin users page** — list all accounts, add users, reset passwords,
  delete accounts (API mostly exists already)
- [ ] **Roles** — beyond the single admin flag if a second tier ever proves
  useful; keep it minimal until then
- [ ] **Invite/reset links** — optional; manual account creation covers the
  private-server case for now

## Chat & room settings

Today: room settings live in the chat page's right sidebar — AI trigger,
linked world book, memory profile, context cap, background, members with
talkativeness, last saved memory, prompt-token use. Rooms are created and
renamed from the left sidebar.

- [x] Per-room AI trigger modes + per-member talkativeness *(2026-11-07)*
- [x] Chat settings in the sidebar — world link, memory profile, context
  cap, background *(2026-11-07)*
- [ ] **Room settings panel** — a proper view for the room's configuration
  instead of an ever-growing sidebar section
- [ ] **Member management** — seat/remove humans and AI cards from one
  place, with talkativeness alongside
- [ ] **Room list polish** — unread/message counts, maybe last-activity sort

## Smart memory sections

Today: smart memories are auto-extracted bullets with a type tag
(fact/event/relationship/preference) and optional trigger keywords. They
live in one room-scoped list; profiles control how/when extraction runs.

- [x] Typed smart memories with trigger keywords *(2026-11-07)*
- [x] Shared + per-character permanent memories *(2026-11-07)*
- [ ] **Organize the prompt view** — show smart memories grouped by section
  (per type and per character) so it's clear what the AI is carrying into
  each generation
- [ ] **Review flow** — glance at what extraction produced, edit or promote
  good ones to permanent, discard noise
- [ ] **Dedup/merge** — collapse near-duplicate extracted facts over time
- [ ] **Per-character smart scope** — extraction currently writes
  room-scoped; character-scoped smart memories are the natural next step

## Smaller items

- [x] Seeded first-run demo — users, room, character, lorebook, memories
  *(2026-11-13)*
- [x] Identicon avatars for seeded cards *(2026-11-13)*
- [ ] **Swipes** — regenerate a reply and keep alternates
- [ ] **Message edit** — for humans and AI replies
- [ ] **Deeper prompt inspector** — per-block token breakdown is partly
  there; visualize injection order vs. actual request
- [ ] **Notification affordances** — unread markers per room
