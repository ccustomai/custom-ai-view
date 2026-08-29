/*
 * Turns the project's brand PNG into the two assets VS Code needs:
 *
 *   media/activity.svg  a monochrome vector trace, because activity-bar icons are
 *                       recoloured by the theme and must be a silhouette
 *   media/icon.png      a 128×128 marketplace icon
 *
 * No image library: the PNG is decoded by hand (inflate + unfilter), the mask is
 * traced with marching squares, each contour simplified with Douglas–Peucker, and
 * the result re-encoded with a hand-rolled PNG writer.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BRAND = 'C:\\Users\\SER\\Downloads\\Custom AI V1 6\\public\\brand';
const OUT = path.join(__dirname, '..', 'media');

// ------------------------------------------------------------- PNG decode

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + file);

  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  if (depth !== 8) throw new Error('only 8-bit PNGs are supported, got ' + depth);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colour type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[i] = value & 0xff;
    }
  }

  // Normalise everything to RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }

  return { width, height, data: rgba };
}

// ------------------------------------------------------------- PNG encode

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = data => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filter downscale, which is what keeps a 1024px logo crisp at 128px. */
function resize(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const sx = img.width / size;
  const sy = img.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4;
          const alpha = img.data[i + 3] / 255;
          r += img.data[i] * alpha; g += img.data[i + 1] * alpha; b += img.data[i + 2] * alpha;
          a += img.data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const cover = a / (n * 255) || 1;
      out[o] = Math.round(r / n / cover);
      out[o + 1] = Math.round(g / n / cover);
      out[o + 2] = Math.round(b / n / cover);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, data: out };
}

// --------------------------------------------------------------- tracing

/**
 * Ink = anything that is neither near-white nor transparent.
 *
 * The source is the transparent brand mark, so alpha does most of the work; the
 * luminance test is what still separates the mark from a white plate if a version
 * without transparency is ever passed in.
 */
function mask(img, grid) {
  const m = new Uint8Array(grid * grid);
  const sx = img.width / grid;
  const sy = img.height / grid;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let ink = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4;
          const a = img.data[i + 3];
          const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          const chroma = Math.max(r, g, b) - Math.min(r, g, b);
          if (a > 40 && (luma < 225 || chroma > 26)) ink++;
          n++;
        }
      }
      m[y * grid + x] = ink / n > 0.5 ? 1 : 0;
    }
  }
  return m;
}

/**
 * Marching squares over the mask.
 *
 * Segments are emitted *directed*, with the inside always on the same side, so
 * following end-point to start-point walks a closed loop. Holes come out as their
 * own loops wound the other way, which is what fill-rule="evenodd" needs.
 */
function contours(m, grid) {
  const at = (x, y) => (x < 0 || y < 0 || x >= grid || y >= grid ? 0 : m[y * grid + x]);
  const segments = [];

  for (let y = -1; y < grid; y++) {
    for (let x = -1; x < grid; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const idx = tl * 8 + tr * 4 + br * 2 + bl;
      if (idx === 0 || idx === 15) continue;

      // Corner samples are pixel centres, so a crossing sits at the edge midpoint.
      const T = [x + 0.5, y];
      const R = [x + 1, y + 0.5];
      const B = [x + 0.5, y + 1];
      const L = [x, y + 0.5];
      const push = (a, b) => segments.push([a, b]);

      switch (idx) {
        case 1:  push(B, L); break;
        case 2:  push(R, B); break;
        case 3:  push(R, L); break;
        case 4:  push(T, R); break;
        case 5:  push(T, R); push(B, L); break;
        case 6:  push(T, B); break;
        case 7:  push(T, L); break;
        case 8:  push(L, T); break;
        case 9:  push(B, T); break;
        case 10: push(L, T); push(R, B); break;
        case 11: push(R, T); break;
        case 12: push(L, R); break;
        case 13: push(B, R); break;
        case 14: push(L, B); break;
        default: break;
      }
    }
  }

  const key = p => p[0].toFixed(2) + ',' + p[1].toFixed(2);
  const byStart = new Map();
  for (const s of segments) {
    const k = key(s[0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(s);
  }

  const used = new Set();
  const loops = [];
  for (const seed of segments) {
    if (used.has(seed)) continue;
    const loop = [seed[0]];
    let cur = seed;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(cur[1]);
      const candidates = byStart.get(key(cur[1])) || [];
      cur = candidates.find(s => !used.has(s));
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const run = (pts, first, last, keep) => {
    let maxD = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = dist(pts[i], pts[first], pts[last]);
      if (d > maxD) { maxD = d; index = i; }
    }
    if (maxD > tolerance && index > 0) {
      run(pts, first, index, keep);
      keep.push(pts[index]);
      run(pts, index, last, keep);
    }
  };
  const keep = [points[0]];
  run(points, 0, points.length - 1, keep);
  keep.push(points[points.length - 1]);
  keep.sort((a, b) => points.indexOf(a) - points.indexOf(b));
  return keep;
}

/** Ink bounds, so the glyph fills the icon instead of floating in the source padding. */
function inkBounds(m, grid) {
  let minX = grid, minY = grid, maxX = -1, maxY = -1;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      if (!m[y * grid + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
}

function toPath(loops, bounds, size, pad, tolerance) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const inner = size - pad * 2;
  const k = inner / Math.max(w, h);
  // Centre the shorter axis so the glyph is not pushed against one edge.
  const offX = pad + (inner - w * k) / 2;
  const offY = pad + (inner - h * k) / 2;
  const fx = n => Math.round(((n - bounds.minX) * k + offX) * 100) / 100;
  const fy = n => Math.round(((n - bounds.minY) * k + offY) * 100) / 100;

  return loops
    .map(loop => {
      const pts = simplify(loop, tolerance);
      if (pts.length < 3) return '';
      let d = 'M' + fx(pts[0][0]) + ' ' + fy(pts[0][1]);
      for (let i = 1; i < pts.length; i++) d += 'L' + fx(pts[i][0]) + ' ' + fy(pts[i][1]);
      return d + 'Z';
    })
    .filter(Boolean)
    .join('');
}

// ------------------------------------------------------------------ run

// The transparent brand mark: the same artwork the product itself ships with.
const solid = decodePng(path.join(BRAND, 'logo-rgba-safe.png'));
const markSrc = solid;

const GRID = 400;
const m = mask(solid, GRID);
const loops = contours(m, GRID);
const bounds = inkBounds(m, GRID);
const d = toPath(loops, bounds, 24, 1.2, 0.45);

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n' +
  '  <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="' + d + '"/>\n' +
  '</svg>\n';

fs.writeFileSync(path.join(OUT, 'activity.svg'), svg, 'utf8');
console.log(
  'activity.svg: ' + loops.length + ' contours, ' + svg.length + ' bytes, ' +
  'ink bounds ' + JSON.stringify(bounds)
);

/** Trim the transparent margin so the mark fills the icon it is drawn into. */
function cropToInk(img, padRatio) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img;

  // Square the crop so the mark is not stretched, then add a little breathing room.
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const side = Math.round(Math.max(w, h) * (1 + (padRatio || 0.12)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x0 = Math.round(cx - side / 2);
  const y0 = Math.round(cy - side / 2);

  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      img.data.copy(out, (y * side + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
    }
  }
  return { width: side, height: side, data: out };
}

const cropped = cropToInk(markSrc, 0.14);
const icon = resize(cropped, 128);
fs.writeFileSync(path.join(OUT, 'icon.png'), encodePng(128, 128, icon.data));
console.log('icon.png: 128x128, transparent, cropped to the mark');

// A larger copy for the panel's own start page.
const big = resize(cropped, 256);
fs.writeFileSync(path.join(OUT, 'logo.png'), encodePng(256, 256, big.data));
console.log('logo.png: 256x256, transparent');
