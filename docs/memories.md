# Memories — Design & Flow

This document describes how the memories system in BOLLOCKS works, who can do
what, and the intended refinements. It accompanies the code in `src/db.js`,
`src/server.js`, `src/generate.js`, `public/memories.html`, and `public/app.js`.

## Concepts

There are two kinds of memory, distinguished by `source`:

| Kind | `source` | Created by | Scope | Lifetime |
|---|---|---|---|---|
| **Permanent** | `manual` | User (always user-driven) | Room-shared or character (card) | Until user deletes it |
| **Smart** | `auto` | AI extraction | **Room only** (shared) | Capped (`mem_max`); oldest auto dropped |

### Permanent memories (user-driven)

- Created explicitly by a user through the Memories UI or API.
- `type` defaults to `fact`; user can set `fact` / `event` / `relationship` / `preference`.
- `triggers` empty = always inject; otherwise keyword-gated.
- **Ownership / edit rights:**
  - A user may edit/delete **character memories** for cards they **own** (`cards.owner_users_id_fk === user`).
  - A user may edit/delete **room (shared) memories** for any room they are a **member of**.
  - Permanent memories are never auto-created, never auto-capped, never auto-deleted.
- Card-scoped permanent memories travel with that character **within the room** they were created in (they are stored with both `cards_id_fk` and `rooms_id_fk`).

### Smart memories (AI-extracted)

- Created automatically by `maybeSummarize()` after every `mem_every` messages when `auto_mem=1`.
- Extraction runs against the room owner's active profile (see open issue: profile selection not persisted).
- **Smart memories belong to the chat (room) only** — they are always stored as shared room memories (`cards_id_fk = NULL`).
  - Rationale: deciding whether an extracted fact belongs to a specific character vs. the chat as a whole is ambiguous and error-prone. Keep smart memories room-scoped; users can promote a fact to a character's permanent memory manually if desired.
- Capped to `mem_max` per room (oldest `source='auto'` dropped). Permanent memories are never subject to the cap.
- Watermark (`mem_last_messages_id`) advances only after a successful extraction.

## Scoping model

```
memory
├── rooms_id_fk  (always set — the chat it lives in)
└── cards_id_fk
    ├── NULL      → shared room memory (visible to everyone in the room)
    └── <card>    → character memory (visible when that card is in the room)
```

Injection at generation time (see `generateReply`):
1. Shared room memories (`cards_id_fk IS NULL`, trigger-filtered, budget-capped).
2. This card's own memories (`cards_id_fk = card`, trigger-filtered, budget-capped against remaining budget).
3. Budget = `rooms.mem_budget` tokens.

## Ownership & permissions

| Action | Permanent (manual) | Smart (auto) |
|---|---|---|
| Create | User (via UI/API) | System (extraction) |
| Read | Room members / card owners | Room members |
| Edit content/type/triggers | Card owner or room member | No (read-only; regenerate via extraction) |
| Delete | Card owner or room member | Room member (or auto-capped) |
| Move between scopes (card ↔ shared) | User (via move) | No |

**Room membership** is determined by `room_members` (junction) plus the room's existence. A user is considered a member of a room if they appear in `room_members` for that room, or are the room owner/creator.

## Flow chart

```mermaid
flowchart TD
    Start([User opens Memories page]) --> Auth{Authenticated?}
    Auth -- no --> Login[Login page]
    Auth -- yes --> LoadRooms[Load rooms user is member of]
    LoadRooms --> SelectRoom[Select room (self-heal stale id)]
    SelectRoom --> Tabs{Tab}

    Tabs -->|Permanent| PermList[Show manual memories<br/>room-shared + card-scoped]
    Tabs -->|Smart| SmartList[Show auto memories<br/>room-scoped only]
    Tabs -->|Settings| Settings[Room memsettings<br/>auto_mem, mem_every, budget, max]

    %% Permanent creation
    PermList --> AddMem{Add memory}
    AddMem --> Scope{Scope}
    Scope -->|Shared room| InsShared[INSERT memories<br/>cards_id_fk=NULL, source=manual]
    Scope -->|Character card (owned)| InsCard[INSERT memories<br/>cards_id_fk=card, source=manual]
    InsShared --> PermList
    InsCard --> PermList

    %% Permanent editing
    PermList --> Edit{Edit/delete?}
    Edit -->|Owner or room member| Update[UPDATE/DELETE memory]
    Edit -->|Not owner/member| Deny[403 Forbidden]
    Update --> PermList

    %% Smart extraction
    Chat([Chat message sent]) --> MaybeSum[MaybeSummarize room]
    MaybeSum --> CheckAuto{auto_mem=1?}
    CheckAuto -- no --> Skip[Skip]
    CheckAuto -- yes --> CheckInterval{messages since watermark >= mem_every?}
    CheckInterval -- no --> Skip
    CheckInterval -- yes --> Extract[LLM extracts facts<br/>room owner's profile]
    Extract --> StoreShared[INSERT as shared room memories<br/>source=auto, cards_id_fk=NULL]
    StoreShared --> Cap[Cap to mem_max<br/>drop oldest auto]
    Cap --> Watermark[Advance watermark]
    Watermark --> SmartList

    %% Injection
    Gen([Generate reply for card]) --> Inject[Load shared + card memories<br/>trigger-filtered, budget-capped]
    Inject --> Prompt[Inject into system prompt]

    %% Move
    PermList --> Move{Move memory?}
    Move -->|User owns target scope| MoveMem[UPDATE cards_id_fk<br/>card <-> NULL]
    MoveMem --> PermList
```

## API contract (intended)

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/memories?card=&room=` | GET | user | List memories. `card=-1` all in room; `card=0` shared only; `card>0` that card. |
| `/api/memories` | POST | user + ownership | Create. `{cardId, room, content, type?, triggers?}`. `cardId=0`/null = shared. Requires card ownership or room membership. |
| `/api/memories/delete` | POST | user + ownership | `{id}`. Delete if owner/member. |
| `/api/memories/update` | POST | user + ownership | `{id, content?, type?, triggers?}`. |
| `/api/memories/move` | POST | user + ownership | `{id, cardId}`. Move between card and shared. |
| `/api/room/memsettings` | POST | room member | `{room, auto, every, budget, max, profileId?}`. Persist profile selection. |
| `/api/lastmem?room=` | GET | user | Latest `source='auto'` memory in room. |

## Known issues to fix (tracked)

1. `/api/memories/delete`, `/triggers`, `/move` read `b.world_books_id_pk` instead of `b.id` — mismatched with frontend. Fix to `b.id`.
2. `/api/memories/triggers` filters by `rooms_id_pk` instead of `memories_id_pk` — would update all memories in a room. Fix filter.
3. No ownership/auth checks on memory endpoints or memsettings. Add per the table above.
4. Smart extraction stores everything as shared (strips `[Name]`) — acceptable per design; document it.
5. Extraction profile (`set_profile`) not persisted — add `api_profiles_id_fk` to `rooms` or store in settings.
6. `POST /api/memories` doesn't accept `type`/`triggers` from frontend.
7. Consider adding `updated` timestamp and `owner_users_id_fk` for audit.

## Open design questions

- Should permanent card memories be visible across rooms if the same card is in multiple rooms? Currently scoped per room. Leaning: keep per-room (matches smart memories; avoids cross-room leakage).
- Should smart memories ever be attributed to a character? Decided no — room-scoped only, to avoid ambiguity. Users can promote manually.
- Should there be a "global character memory" (ST-style)? Deferred; would need `rooms_id_fk IS NULL` support + UI scope selector.
