#!/usr/bin/env node
// scripts/generate-icon.js
// Generates public/icon.png (256×256 RGBA) from the favicon color scheme.
// Uses only Node.js built-ins — no npm packages required.
// electron-builder converts it to .ico automatically during the Windows build.

import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'icon.png');

const W = 256, H = 256, RADIUS = 28;

// Favicon gradient: #ff6b35 → #f7931e (top-left to bottom-right)
const C0 = [0xff, 0x6b, 0x35];
const C1 = [0xf7, 0x93, 0x1e];

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Raw scanlines: filter byte (0=None) + W*4 RGBA bytes per row
const raw = Buffer.alloc(H * (1 + W * 4));

for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const off = y * (1 + W * 4) + 1 + x * 4;

    // Diagonal gradient 0→1
    const t = (x + y) / (W + H - 2);

    // Rounded corners — pixels outside corner arcs are transparent
    let alpha = 255;
    const inLeftZone  = x < RADIUS;
    const inRightZone = x > W - 1 - RADIUS;
    const inTopZone   = y < RADIUS;
    const inBotZone   = y > H - 1 - RADIUS;

    if ((inLeftZone || inRightZone) && (inTopZone || inBotZone)) {
      const cx = inLeftZone ? RADIUS : W - 1 - RADIUS;
      const cy = inTopZone  ? RADIUS : H - 1 - RADIUS;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > RADIUS * RADIUS) alpha = 0;
    }

    raw[off]     = lerp(C0[0], C1[0], t);
    raw[off + 1] = lerp(C0[1], C1[1], t);
    raw[off + 2] = lerp(C0[2], C1[2], t);
    raw[off + 3] = alpha;
  }
}

// ── PNG encoder (pure JS) ────────────────────────────────────────────────────

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// CRC-32 table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const tb = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), tb, data, u32(crc32(Buffer.concat([tb, data])))]);
};

const IHDR = Buffer.concat([u32(W), u32(H), Buffer.from([8, 6, 0, 0, 0])]); // 8-bit RGBA
const IDAT = deflateSync(raw, { level: 9 });
const SIG  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

writeFileSync(OUT, Buffer.concat([SIG, chunk('IHDR', IHDR), chunk('IDAT', IDAT), chunk('IEND', Buffer.alloc(0))]));
console.log(`✓ Generated ${OUT} (256×256 RGBA, orange gradient)`);
