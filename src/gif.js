/*
 * Animated GIF encoder.
 *
 * Screen recordings need a format that pastes straight into a chat, and GIF is the
 * only one a Node process can write without a codec. Frames arrive as PNGs from the
 * DevTools screencast, so this file decodes them, quantises to a shared 255-colour
 * palette by median cut, and LZW-encodes each frame.
 */
'use strict';

const zlib = require('zlib');

// ------------------------------------------------------------- PNG decode

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
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
      if (data[12] !== 0) throw new Error('interlaced png');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8) throw new Error('unsupported png bit depth ' + depth);

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported png colour type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = raw[rp + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad png filter ' + filter);
      }
      cur[i] = v & 0xff;
    }
    rp += stride;
  }

  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

// ------------------------------------------------------------ quantise

/**
 * Median cut over a sample of pixels from every frame, so the palette suits the whole
 * recording rather than whichever frame happened to be first.
 */
function buildPalette(frames, maxColors) {
  const samples = [];
  const stride = Math.max(1, Math.floor((frames[0].width * frames[0].height) / 4000));
  for (const frame of frames) {
    for (let i = 0; i < frame.width * frame.height; i += stride) {
      samples.push([frame.rgb[i * 3], frame.rgb[i * 3 + 1], frame.rgb[i * 3 + 2]]);
    }
  }

  const boxes = [{ pixels: samples }];
  while (boxes.length < maxColors) {
    // Split the box with the widest channel spread; that is where banding shows.
    let best = -1;
    let bestRange = -1;
    let bestChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      const px = boxes[i].pixels;
      if (px.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of px) {
          if (p[c] < lo) lo = p[c];
          if (p[c] > hi) hi = p[c];
        }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = i; bestChannel = c; }
      }
    }
    if (best < 0 || bestRange <= 0) break;
    const box = boxes[best];
    box.pixels.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = box.pixels.length >> 1;
    boxes.splice(best, 1,
      { pixels: box.pixels.slice(0, mid) },
      { pixels: box.pixels.slice(mid) });
  }

  const palette = boxes
    .filter(b => b.pixels.length)
    .map(b => {
      let r = 0, g = 0, bl = 0;
      for (const p of b.pixels) { r += p[0]; g += p[1]; bl += p[2]; }
      const n = b.pixels.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });

  while (palette.length < 2) palette.push([0, 0, 0]);
  return palette;
}

function nearestIndex(palette, r, g, b, cache) {
  const key = (r >> 2 << 12) | (g >> 2 << 6) | (b >> 2);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    const d = dr * dr * 3 + dg * dg * 4 + db * db * 2; // eye weighting
    if (d < bestDist) { bestDist = d; best = i; }
  }
  cache.set(key, best);
  return best;
}

// ----------------------------------------------------------------- LZW

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let dict = new Map();

  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = code => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const reset = () => {
    dict = new Map();
    next = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  emit(clearCode);
  reset();

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }
    emit(prefix);
    dict.set(key, next);
    next++;
    if (next > (1 << codeSize)) {
      if (codeSize < 12) codeSize++;
      else {
        emit(clearCode);
        reset();
      }
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);

  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Buffer.from(out);
}

function blockify(data) {
  const chunks = [];
  for (let i = 0; i < data.length; i += 255) {
    const slice = data.slice(i, i + 255);
    chunks.push(Buffer.from([slice.length]), slice);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------- encode

/**
 * @param {Buffer[]} pngFrames
 * @param {{delayMs?: number, maxColors?: number}} opts
 */
function encodeGif(pngFrames, opts = {}) {
  if (!pngFrames.length) throw new Error('no frames to encode');

  const frames = pngFrames.map(decodePng);
  const { width, height } = frames[0];
  const maxColors = Math.min(256, Math.max(8, opts.maxColors || 200));
  const palette = buildPalette(frames, maxColors);

  // GIF colour tables are a power of two.
  let tableSize = 2;
  let tableBits = 1;
  while (tableSize < palette.length) { tableSize *= 2; tableBits++; }

  const table = Buffer.alloc(tableSize * 3);
  palette.forEach((c, i) => {
    table[i * 3] = c[0];
    table[i * 3 + 1] = c[1];
    table[i * 3 + 2] = c[2];
  });

  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | ((tableBits - 1) & 0x07); // global table, its size
  lsd[5] = 0;
  lsd[6] = 0;
  parts.push(lsd, table);

  // Loop forever.
  parts.push(Buffer.from([0x21, 0xff, 0x0b]));
  parts.push(Buffer.from('NETSCAPE2.0', 'ascii'));
  parts.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  const delay = Math.max(2, Math.round((opts.delayMs || 100) / 10));
  const cache = new Map();
  const minCodeSize = Math.max(2, tableBits);

  for (const frame of frames) {
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 0x04;
    gce[3] = 0x04; // do not dispose
    gce.writeUInt16LE(delay, 4);
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    desc[9] = 0; // no local table
    parts.push(desc);

    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = nearestIndex(
        palette,
        frame.rgb[i * 3],
        frame.rgb[i * 3 + 1],
        frame.rgb[i * 3 + 2],
        cache
      );
    }

    parts.push(Buffer.from([minCodeSize]));
    parts.push(blockify(lzwEncode(indices, minCodeSize)));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

module.exports = { encodeGif, decodePng };
