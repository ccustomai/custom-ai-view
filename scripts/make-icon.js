/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Draws media/icon.png (128×128) with no image library — raw RGBA scanlines,
 * zlib for the IDAT chunk, hand-rolled CRC32 for the chunk framing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const buf = Buffer.alloc(SIZE * SIZE * 4);

const px = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const alpha = a === undefined ? 1 : a;
  if (alpha >= 1) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    return;
  }
  buf[i] = Math.round(buf[i] * (1 - alpha) + r * alpha);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - alpha) + g * alpha);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - alpha) + b * alpha);
  buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * alpha));
};

/** Coverage of a rounded rectangle at a point, anti-aliased by 3×3 supersampling. */
const roundRectCoverage = (x, y, rx, ry, rw, rh, radius) => {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px0 = x + (sx + 0.5) / 3;
      const py0 = y + (sy + 0.5) / 3;
      if (px0 < rx || py0 < ry || px0 > rx + rw || py0 > ry + rh) continue;
      const cx = Math.min(Math.max(px0, rx + radius), rx + rw - radius);
      const cy = Math.min(Math.max(py0, ry + radius), ry + rh - radius);
      const dx = px0 - cx;
      const dy = py0 - cy;
      if (dx * dx + dy * dy <= radius * radius + 1e-6) hits++;
    }
  }
  return hits / 9;
};

const fillRoundRect = (rx, ry, rw, rh, radius, color, alpha = 1) => {
  const [r, g, b] = color;
  for (let y = Math.floor(ry) - 1; y <= Math.ceil(ry + rh) + 1; y++) {
    for (let x = Math.floor(rx) - 1; x <= Math.ceil(rx + rw) + 1; x++) {
      const cov = roundRectCoverage(x, y, rx, ry, rw, rh, radius);
      if (cov > 0) px(x, y, r, g, b, cov * alpha);
    }
  }
};

const strokeRoundRect = (rx, ry, rw, rh, radius, width, color, alpha = 1) => {
  const [r, g, b] = color;
  const inner = { x: rx + width, y: ry + width, w: rw - width * 2, h: rh - width * 2, r: Math.max(0, radius - width) };
  for (let y = Math.floor(ry) - 1; y <= Math.ceil(ry + rh) + 1; y++) {
    for (let x = Math.floor(rx) - 1; x <= Math.ceil(rx + rw) + 1; x++) {
      const outer = roundRectCoverage(x, y, rx, ry, rw, rh, radius);
      if (outer <= 0) continue;
      const hole = roundRectCoverage(x, y, inner.x, inner.y, inner.w, inner.h, inner.r);
      const cov = Math.max(0, outer - hole);
      if (cov > 0) px(x, y, r, g, b, cov * alpha);
    }
  }
};

// Background: deep navy with a soft top-left glow, matching the gallery banner.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = y / SIZE;
    const base = [
      Math.round(14 + t * 6),
      Math.round(17 + t * 7),
      Math.round(26 + t * 12),
    ];
    const dx = (x - 30) / 90;
    const dy = (y - 18) / 90;
    const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) * 0.55;
    px(
      x,
      y,
      Math.round(base[0] + glow * 52),
      Math.round(base[1] + glow * 66),
      Math.round(base[2] + glow * 104),
      1
    );
  }
}
fillRoundRect(0, 0, SIZE, SIZE, 0, [0, 0, 0], 0); // keep corners square for the marketplace

// Phone body
fillRoundRect(38, 16, 52, 96, 14, [232, 238, 250], 1);
fillRoundRect(41.5, 19.5, 45, 89, 11, [10, 12, 18], 1);

// Screen with an iOS-blue wallpaper
fillRoundRect(43.5, 21.5, 41, 85, 9.5, [24, 108, 246], 1);
for (let y = 22; y < 106; y++) {
  for (let x = 44; x < 85; x++) {
    const cov = roundRectCoverage(x, y, 43.5, 21.5, 41, 85, 9.5);
    if (cov <= 0) continue;
    const t = (y - 22) / 84;
    px(x, y, Math.round(24 + t * 46), Math.round(108 - t * 34), Math.round(246 - t * 62), cov);
  }
}

// Dynamic Island
fillRoundRect(56, 25, 16, 6.5, 3.25, [4, 5, 8], 1);

// Home indicator
fillRoundRect(56, 100.5, 16, 2.6, 1.3, [255, 255, 255], 0.92);

// Side buttons
fillRoundRect(36.4, 40, 2.6, 8, 1.2, [150, 158, 176], 1);
fillRoundRect(36.4, 52, 2.6, 12, 1.2, [150, 158, 176], 1);
fillRoundRect(89, 46, 2.6, 16, 1.2, [150, 158, 176], 1);

// Measurement ticks, the "pixel-exact" idea in one glyph
strokeRoundRect(20, 44, 8, 40, 3, 2, [120, 176, 255], 0.9);
strokeRoundRect(100, 44, 8, 40, 3, 2, [120, 176, 255], 0.9);

// ------------------------------------------------------------------ encode

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = data => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filtering
ihdr[12] = 0;  // no interlace

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + png.length + ' bytes)');
