# What is BOLLOCKS?

**Bots' Own Lore Logic & Open Chat Konversation System**

- Group chat that allows a mixture of AI and humans while maintaining control over your own AI character's API key and personality

## Why over SillyTavern?

- SillyTavern is great for single character interactions, but BOLLOCKS is designed for group chat with multiple AI characters and humans

## Why the rebuild rather than extending SillyTavern?

- SillyTavern is a dumb backend that relies on the frontend to do all the work. This is OK if you are wanting to run the server on a potato however the frontend is very heavy and slow.
- BOLLOCKS uses a SQLite database for all data storage, making it much faster and more reliable.
- ST's chat is a JSON file appended per message. Two humans writing at once is last-write-wins — one save clobbers the other's messages, and multi-account "mirror" chats were an attampted hack on top of that, not a fix.
- True multiplayer needs a real database as source of truth, server-side auth and ownership, and thin clients — none of which bolt onto ST cleanly without fighting the file model.

## Features

- **Group chat** with multiple AI characters and humans in one room
- **Control over your own AI character's API key and personality** — every profile is per-user; cards can pick a profile or fall back to the room default
- **Personas** — your own player character; your messages carry its name and avatar
- **Import existing SillyTavern characters** (V1/V2/V3 PNG + JSON) **and LoreBooks**
- **World books** — keyword-triggered and constant lore entries, linkable per chat
- **Memories** — permanent (manual, per-character or shared) and smart (AI-extracted room memories with type tags and trigger keywords)
- **AI activation** — manual / every message / named / round-robin, plus per-member talkativeness
- **Context caps** — per-chat and per-profile token limits; history middle-trims to fit
- **Live updates** — messages, deletions and memory extraction stream to all clients
- **Prompt transparency** — per-block token inspector in the chat sidebar, and a per-room log of the last 50 prompts/responses actually sent to the LLM

# Getting started

```bash
npm install
npm start          # http://localhost:8100
```

Environment overrides: `PORT` for the listen port, `BOLLOCKS_DATA` for the data directory (database + avatars + backgrounds — point a local dev server at a copied prod `data/` for realistic testing), `BOLLOCKS_SEED=0` to skip seeding.

Dev commands: `npm test` (route + generation suites against mock LLMs), `npm run lint`.

First run seeds a demo: four demo users (`admin` — the site admin — plus `alice`, `bob`, `carol`, all password `changeme`), a chat called **The House** with the character **Wren** seated in it, a linked lorebook, and some example memories — so there's something to click through straight away. Skip it with `BOLLOCKS_SEED=0` and register your own account instead.

To actually generate replies, sign in and set up an API connection on the **Connection** page (any OpenAI-compatible endpoint works).

# The tour

## Sign in

Everything behind the login page is gated — no session, no app.

![Login](docs/screenshots/login.png)

## Chat

The room you're in, who's in it, and who's listening. The right sidebar holds the AI trigger mode, chat settings (linked world book, memory profile, context cap, background), the last memory the AI saved, and prompt-token use. `NPC ▸` asks an AI member to reply.

![Chat](docs/screenshots/chat.png)

## Characters

Your card collection — SillyTavern V1/V2/V3 PNGs and JSON import straight in. Each card carries its own personality fields and can pin an API profile, or fall back to your default.

![Characters](docs/screenshots/characters.png)

## World

Lorebooks. Pick a book in the sidebar and its entries show as full cards — title, trigger keywords, content, order — with edit-in-place. Entries reach the AI when their keywords come up in a chat the book is linked to.

![World](docs/screenshots/world.png)

## Memories

Two kinds: **Permanent** memories you write yourself (shared with the room, or scoped to one character), and **Smart** memories the AI extracts from the conversation on its own. Type tags and trigger keywords show on each card; smart memories can be promoted to permanent.

![Memories](docs/screenshots/memories.png)

## Smart memory

The dials for the extraction side: which connection profile does the reading, how often it runs, caps per memory type, injection budget. Saved as named profiles a room can follow.

![Smart memory](docs/screenshots/memsettings.png)

## Connection

Two tabs. **Connection** is the OpenAI-compatible endpoint — URL, model, key (kept server-side), extra headers, context and response caps. **Injection** is prompt assembly: which blocks go into the system prompt and in what order.

![Connection](docs/screenshots/connection.png)

# Where it's going

User management, a proper room settings view, smarter memory organization and more — see [docs/roadmap.md](docs/roadmap.md).

# Nerdy Details

## Tech Stack

- **Backend** — Node.js ES modules, built-in `http` server, no framework
- **Database** — SQLite via `node:sqlite`, embedded file in `data/app.db`
- **Frontend** — plain HTML/JS pages + shared layout shell (`layout.js/css`), no build step
- **Realtime** — Server-Sent Events (`/api/stream`) for message/delete broadcasts
- **Generation** — OpenAI-compatible `chat/completions`; per-profile URL/key/model, custom headers, context size, max response

## Infrastructure

Single SQLite file alongside the code. Schema:

```mermaid
erDiagram
    USERS {
        int users_id_pk PK
        string handle
        string password_hash
        string salt
        string settings
    }
    SESSIONS {
        string sessions_token_pk PK
        int users_id_fk FK
        string created
    }
    API_PROFILES {
        int api_profiles_id_pk PK
        int users_id_fk FK
        string name
        string api_url
        string model
        string key
        int active
        int strip_prefix
        string headers
        int context_size
        int max_response
    }
    CARDS {
        int cards_id_pk PK
        int owner_users_id_fk FK
        string name
        string description
        string personality
        string scenario
        string first_message
        string mes_example
        string system_prompt
        string post_history_instructions
        string alternate_greetings
        string tags
        string creator
        string creatorcomment
        string character_version
        string avatar
        string card_json
        int is_persona
        int api_profiles_id_fk FK
    }
    MEMBERS {
        int members_id_pk PK
        int cards_id_fk FK
        int talkativeness
    }
    ROOM_MEMBERS {
        int rooms_id_fk PK,FK
        int members_id_fk PK,FK
    }
    ROOMS {
        int rooms_id_pk PK
        string name
        string ai_trigger
        int max_context
        string bg
        int owner_users_id_fk FK
        int mem_profiles_id_fk FK
        int mem_last_messages_id
        int mem_refresh_count
    }
    MESSAGES {
        int messages_id_pk PK
        int rooms_id_fk FK
        int cards_id_fk FK
        string text
        string send_date
        int supersedes
    }
    MEMORIES {
        int memories_id_pk PK
        string content
        string created
        string type
        string origin "user|smart"
        string triggers
    }
    ROOM_MEMORIES {
        int rooms_id_fk PK,FK
        int memories_id_fk PK,FK
    }
    MEMORY_CARDS {
        int memories_id_fk PK,FK
        int cards_id_fk PK,FK
    }
    MEM_PROFILES {
        int mem_profiles_id_pk PK
        int users_id_fk FK
        string name
        int auto_mem
        int mem_every
        int mem_budget
        int mem_max
        string mem_extraction_prompt
        int mem_context_threshold
        int mem_unified
        int mem_triggers
        int mem_refresh
        int mem_extraction_profile_id
    }
    PROMPT_PROFILES {
        int prompt_profiles_id_pk PK
        int users_id_fk FK
        string name
        string prompt_order
        int active
    }
    PROMPT_LOGS {
        int prompt_logs_id_pk PK
        int rooms_id_fk FK
        int cards_id_fk FK "null = extraction"
        string kind "reply|extract"
        string request
        string response
        int prompt_tokens
        int completion_tokens
        string created
    }
    WORLD_BOOKS {
        int world_books_id_pk PK
        int owner_users_id_fk FK
        string name
        string created
    }
    ROOM_BOOKS {
        int rooms_id_fk PK,FK
        int world_books_id_fk PK,FK
    }
    BOOK_ENTRIES {
        int world_books_id_fk PK,FK
        int world_entries_id_fk PK,FK
    }
    WORLD_ENTRIES {
        int world_entries_id_pk PK
        string content
        int constant
        int enabled
        int ord
        string comment
    }
    WORLD_ENTRY_KEYS {
        int world_entries_id_fk PK,FK
        string word PK
        string kind PK "primary|secondary"
    }

    USERS ||--o{ SESSIONS : has
    USERS ||--o{ API_PROFILES : owns
    USERS ||--o{ CARDS : owns
    USERS ||--o{ WORLD_BOOKS : owns
    USERS ||--o{ MEM_PROFILES : owns
    USERS ||--o{ PROMPT_PROFILES : owns
    CARDS ||--o{ MEMBERS : "is a member"
    CARDS ||--o{ MESSAGES : speaks
    CARDS ||--o{ MEMORY_CARDS : "scoped memories"
    CARDS }o--o| API_PROFILES : "optional override"
    CARDS ||--o{ PROMPT_LOGS : generates
    MEMBERS ||--o{ ROOM_MEMBERS : sits
    ROOMS ||--o{ ROOM_MEMBERS : has
    ROOMS ||--o{ MESSAGES : holds
    ROOMS ||--o{ ROOM_MEMORIES : shares
    ROOMS ||--o{ ROOM_BOOKS : links
    ROOMS ||--o{ PROMPT_LOGS : logs
    ROOMS }o--o| MEM_PROFILES : follows
    MEM_PROFILES }o--o| API_PROFILES : "extraction profile"
    MEMORIES ||--o{ ROOM_MEMORIES : linked
    MEMORIES ||--o{ MEMORY_CARDS : linked
    WORLD_BOOKS ||--o{ ROOM_BOOKS : linked
    WORLD_BOOKS ||--o{ BOOK_ENTRIES : contains
    WORLD_ENTRIES ||--o{ BOOK_ENTRIES : member
    WORLD_ENTRIES ||--o{ WORLD_ENTRY_KEYS : triggers
    MESSAGES }o--o| MESSAGES : supersedes
```

- **users** — accounts (`handle`, `password_hash`/`salt`)
- **sessions** — bearer tokens (`sessions_token_pk`)
- **api_profiles** — connections (`api_url`, `model`, `key`, `active`, `headers`, `context_size`, `max_response`)
- **cards** — characters (owner, ST fields, `is_persona`, `api_profiles_id_fk` override, `avatar`)
- **members** — a card's seat: `cards_id_fk` + `talkativeness` (persona card = human)
- **room_members** — junction: which members sit in which rooms
- **rooms** — chats (`ai_trigger`, `max_context`, `bg`, `mem_profiles_id_fk` → the memory profile it follows, `owner_users_id_fk`, extraction watermark + refresh counter)
- **messages** — chat log (`rooms_id_fk`, `cards_id_fk` sender, `text`, `supersedes`)
- **memories** — facts shared via junctions, not room/card columns: `type` (fact/event/relationship/preference), `origin` (`user` permanent vs `smart` extracted), `triggers` keyword gate
- **room_memories** — junction: which memories a room can inject
- **memory_cards** — junction: narrows a memory to one character (unlinked = room-shared)
- **mem_profiles** — named memory presets a room follows: extraction cadence/model/prompt, per-type caps, injection budget, trigger + unified-mode toggles
- **prompt_profiles** — named prompt-assembly presets (`prompt_order` block sequence, `active`)
- **prompt_logs** — newest 50 LLM calls per room (`kind` reply|extract, request JSON, raw response, token usage) — the prompt inspector's durable half
- **world_books** — lorebooks (owner, name)
- **room_books** — junction: which books feed which rooms
- **world_entries** — lore entries (`content`, `constant`, `enabled`, `ord`, `comment`)
- **world_entry_keys** — trigger keywords (`word`, `kind` primary|secondary)
- **book_entries** — junction: which entries live in which books