// Deterministic identicon-style avatars — 5x5 mirrored blocks tinted by a
// hash of the seed string, encoded as a PNG with zlib only (no deps).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
const crc32 = buf => {
    let c = ~0;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};
const hsl = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

export function identiconPng(seedStr, size = 128) {
    let h = 0x811c9dc5;
    for (const ch of seedStr) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 0xffffffff; };
    const hue = Math.floor(rnd() * 360);
    const [fr, fg, fb] = hsl(hue, 0.55, 0.62);
    const [br, bg, bb] = hsl(hue, 0.22, 0.15);
    const cells = 5, px = Math.floor(size / cells), pad = Math.floor((size - px * cells) / 2);
    const grid = [];
    for (let y = 0; y < cells; y++) {
        const row = [];
        for (let x = 0; x < 3; x++) row.push(rnd() < 0.55);
        row[3] = row[1]; row[4] = row[0];
        grid.push(row);
    }
    const raw = Buffer.alloc(size * (size * 3 + 1));
    for (let y = 0; y < size; y++) {
        const base = y * (size * 3 + 1);
        for (let x = 0; x < size; x++) {
            const cx = Math.floor((x - pad) / px), cy = Math.floor((y - pad) / px);
            const on = cx >= 0 && cx < cells && cy >= 0 && cy < cells && grid[cy][cx];
            const o = base + 1 + x * 3;
            raw[o] = on ? fr : br; raw[o + 1] = on ? fg : bg; raw[o + 2] = on ? fb : bb;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}
