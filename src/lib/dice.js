// Dice commands — the multiplayer conflict-resolution convention. A roll is
// resolved by the server (node:crypto), then posted as a system message so it
// becomes chat history: impartial, deterministic, and seen by memory
// extraction as an authoritative outcome.
import { randomInt } from 'node:crypto';

const DICE_RE = /^(\d{1,3})\s*d\s*(\d{1,4})\s*([+-]\s*\d{1,4})?$/i;

/** Parse "NdS±K" and roll it. Returns { expr, rolls, mod, total } or null. */
export function rollDice(expr) {
    const m = String(expr || '').trim().match(DICE_RE);
    if (!m) return null;
    const n = Math.min(Math.max(Number(m[1]) || 1, 1), 100);
    const sides = Number(m[2]);
    if (sides < 2 || sides > 1000) return null;
    const mod = m[3] ? Number(m[3].replace(/\s/g, '')) : 0;
    const rolls = Array.from({ length: n }, () => randomInt(1, sides + 1));
    return { expr: `${n}d${sides}${mod ? (mod > 0 ? '+' : '') + mod : ''}`, rolls, mod, total: rolls.reduce((a, r) => a + r, 0) + mod };
}

/** Human/log-readable roll line: "Blake rolls 2d6+3 → 9 (4, 2 + 3)". With a
 *  target: "… → 9 (4, 2 + 3) vs 10 — fail". The wording doubles as the
 *  extraction convention — outcome words, not narration. */
export function formatRoll(name, r, vs) {
    const dice = r.rolls.length > 1 ? r.rolls.join(', ') : String(r.rolls[0]);
    const detail = r.mod ? `${dice} ${r.mod > 0 ? '+' : '-'} ${Math.abs(r.mod)}` : dice;
    let out = `${name} rolls ${r.expr} → ${r.total} (${detail})`;
    if (vs != null) out += ` vs ${vs} — ${r.total >= vs ? 'success' : 'fail'}`;
    return out;
}
