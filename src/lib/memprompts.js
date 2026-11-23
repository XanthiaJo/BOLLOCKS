import { db } from '../db.js';

// Built-in extraction prompt, used when a profile leaves its template
// blank. The triggers suffix is appended only to the built-in prompt.
export const MEM_EXTRACT_PROMPT = `You extract lasting memories from roleplay chat logs. All memories are shared with the whole chat.
Character sheets included in the input are the AUTHORITATIVE current state for each character — trust them over older chat claims. If the excerpt shows a character's state changing (something fixed, removed, acquired, moved), record the NEW state, not the old.
System lines — "Ruling: …" decisions and "… rolls … → N" dice results — are authoritative outcomes, never contested. When participants disagree about what is true, the most recent message wins.
Output exactly ONE bullet point — the single most important lasting memory from this excerpt. "- " prefix, one line, starting with exactly one type tag — pick the most specific that fits:
- [event] — something that HAPPENED and is DONE: a self-contained action or beat, closed the moment it occurs. "Karima opened the fridge" is an event — nothing stays pending afterward.
- [relationship] — how characters FEEL about each other or a thing. "Ellie adores teasing SirRackington" is a relationship.
- [preference] — a like/dislike/want. "Blake hates green" is a preference.
- [fact] — LAST RESORT: only static truths that aren't events, feelings or preferences — identity, possessions, rules, ongoing states. "SirRackington is a server rack" is a fact.
Do NOT default to [fact] — if the memory describes something that occurred or a feeling, it is NOT a fact. Write a complete sentence that names the subject — no pronouns, no narration.
Example input: "Blake: the Venice API review pile is killing me\\nCreamms: I'll take half of it tomorrow"
Example output:
- [event] Creamms offered to take half of Blake's review pile tomorrow.`;
export const MEM_TRIGGERS_SUFFIX = ' For each memory also append its trigger keywords in parentheses — the words most likely to re-evoke it, including synonyms, titles, and roles, e.g. "- [fact] The king is dead. (triggers: king, monarch, crown, throne)"';
// Arc-tracking addendum for the built-in extraction prompt, appended when the
// profile tracks arcs (mem_max_arcs > 0). Arc lines may appear alongside the
// single memory bullet; [arc] advances and [arc-close] resolves a thread.
// The core teaching is event-vs-thread: a memory is history, a thread is an
// unresolved situation that stays open until something settles it.
export const MEM_ARCS_SUFFIX = ` Threads: a thread is NOT a memory — it is an open situation left pending until it resolves: a debt owed, a repair in progress, an investigation, a brewing conflict, a promise awaiting fulfilment — or a bit building toward a payoff (someone inching an object toward a desk's edge across several messages is one thread, not three events). If the excerpt opens, advances, or resolves one, additionally output "- [arc-open] Title — what is underway", "- [arc] Title — the new development", or "- [arc-close] Title — how it settled". Reuse an open thread's title exactly when updating or closing it. If a numbered memory describes an earlier step of a situation still developing in this excerpt, that is a thread — open or advance it instead of logging another isolated [event]. The test: an event is closed when it happens ("Buddy broke the wheel" is [event]); a thread needs a resolution ("the wheel must be replaced before inspection" is a thread). Transient states — injuries, sanctions, pending fixes, ongoing suspicions — belong to threads, never [fact]: arcs close; facts linger as stale truth.`;

// Periodic LLM dedupe pass — unlike the scripted trigger-overlap sweep it
// can see through paraphrases. The model reviews the room's live memories
// and retires true duplicates by emitting merge lines: each [supersede N]
// tag folds that numbered row into the fresh memory the line carries.
export const MEM_SWEEP_PROMPT = `You deduplicate stored memories from a roleplay chat. Below is a numbered list of the room's live memories.
Find entries that say the SAME thing — one event retold, one fact restated, one feeling rephrased — even in different words. For each duplicate group, write ONE merge line:
- [supersede N] [supersede M] The single best version of that memory. (trigger, keywords)
Each [supersede] tag retires that numbered row — your line replaces all of them at once. Keep the most complete phrasing, name the subject in a full sentence, and always add trigger keywords in parentheses so the merged memory can resurface.
Merge ONLY true duplicates — different facts or events about the same people, places, or objects are not duplicates and stay separate. When in doubt, leave both. If nothing duplicates, reply exactly "- none".`;

// Scene-state snapshot prompt — a dedicated pass that answers "what is true
// right now" (locations, held objects, ongoing conditions). The model emits
// a keyed JSON set — one entry per subject — and the script owns the diff:
// a subject's new value supersedes its old one, subjects absent from the set
// are retracted. Unlike extracted memories it is not cumulative.
export const MEM_STATE_PROMPT = `You track the current scene state of a roleplay chat as a keyed set. From the latest messages (and the previous set, if one is shown), describe what is true RIGHT NOW: where each person is, where important objects are and who holds them, ongoing activities or conditions. Output a single JSON object mapping each subject to its current state, e.g. {"Wren":"in the kitchen","blue tin":"on the counter","common room fire":"burned low"}.
Rules: exactly one entry per subject — the value IS the current truth and replaces whatever was true before. Carry unchanged subjects forward with their exact keys so the diff stays clean. Snapshot, not history — no events, no past states. Subjects are people, objects, and conditions in the fiction only — never metadata about the state set itself (no timestamps, no "scene block" or "as of" rows). System lines — "Ruling: …" decisions and "… rolls … → N" dice results — are authoritative outcomes. When participants disagree about what is true, the most recent message wins. If nothing is trackable, reply {}. Output only the JSON object, no prose.`;

// Fields a memory profile can override on a room's mem_* settings.
export const MEM_PROFILE_FIELDS = ['mem_every', 'mem_budget', 'mem_max', 'mem_max_fact',
    'mem_max_event', 'mem_max_relationship', 'mem_max_preference', 'mem_extraction_prompt',
    'mem_context_threshold', 'mem_response_length', 'mem_gen_budget', 'mem_unlimited',
    'mem_unified', 'mem_triggers', 'mem_autotune', 'mem_refresh', 'mem_activity',
    'extraction_api_profiles_id_fk', 'mem_canon_budget', 'mem_max_arcs', 'mem_arc_budget',
    'arc_api_profiles_id_fk', 'mem_state', 'mem_state_every', 'mem_max_state', 'mem_prune_messages',
    'mem_state_budget', 'mem_state_prompt', 'mem_readonly',
    'mem_sweep', 'mem_sweep_every', 'sweep_api_profiles_id_fk'];

// Named system-prompt sections in cache-optimal order (stable content first —
// see the assembly comment in generateReply). The user's active
// prompt_profiles row can reorder them via prompt_order (JSON array of
// keys); NULL means this order. 'history' is a position marker, not text.
export const PROMPT_BLOCKS = [
    { key: 'main', label: 'Main prompt',
        example: 'You are Aria.' },
    { key: 'description', label: 'Card description',
        example: 'Description:\nAria is a wandering cartographer with a stolen map case.' },
    { key: 'personality', label: 'Card personality',
        example: 'Personality:\ncurious, blunt, secretly kind' },
    { key: 'scenario', label: 'Scenario',
        example: 'Scenario:\nThe party camps at the edge of the drowned forest.' },
    { key: 'examples', label: 'Example dialogue',
        example: 'Example dialogue:\nAria: We were never here.\n{{user}}: Says who?' },
    { key: 'roster', label: 'Other characters',
        example: 'Also present in the scene:\nBlake: a retired knight who owes Aria money' },
    { key: 'canon', label: 'Canon',
        example: 'Canon:\n- The drowned forest was destroyed in the war.' },
    { key: 'world', label: 'World info',
        example: 'World info:\nThe drowned forest floods every new moon.' },
    { key: 'memories', label: 'Memories',
        example: 'Memories:\n- [fact] Aria distrusts the harbor guild.\n- [event] Blake offered to carry the map case.' },
    { key: 'arcs', label: 'Open threads',
        example: 'Open threads:\n- The stolen map — Aria suspects the harbor guild took it' },
    { key: 'scene', label: 'Scene state',
        example: 'Scene (as of 2024-06-01 12:00):\n- Aria holds the stolen map.\n- The common room fire has burned low.' },
    { key: 'instructions', label: 'Instructions',
        example: "You are Aria and ONLY Aria — an NPC in a shared roleplay. The other characters listed are separate people speaking for themselves; do NOT speak for them or imitate them. Write ONLY Aria's next message." },
    { key: 'history', label: 'Chat history',
        example: 'Alice: We should leave before dawn.\nAria: The tide says otherwise.' },
    { key: 'time', label: 'Current time',
        example: 'Current time: Friday 13 November 2026, 21:49. Last message: 3 minutes ago.' },
];

/** Effective memory settings for a room: always the memory profile it follows
 *  via mem_profiles_id_fk. No link → the room's own columns: smart memories
 *  are off. Room columns only carry per-room bits like the injection-refresh
 *  counter. Following a profile IS the enable switch (the old auto_mem
 *  flag was dropped). */
export function memProfileFor(room) {
    const p = room?.mem_profiles_id_fk
        ? db.prepare('SELECT * FROM mem_profiles WHERE mem_profiles_id_pk=?').get(room.mem_profiles_id_fk)
        : null;
    if (!p) return room;
    const out = { ...room };
    for (const k of MEM_PROFILE_FIELDS) if (k in p) out[k] = p[k];
    return out;
}
