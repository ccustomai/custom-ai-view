/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Build the MCP bundle.
 *
 *   node scripts/build-mcpb.js   →  dist/custom-ai-view.mcpb
 *
 * An .mcpb is a zip with a manifest at its root. It matters here for one
 * reason: the MCP Registry — the index a client queries when it goes looking
 * for a server that does something — hosts metadata only, never artifacts, so
 * a server has to be fetchable from somewhere it recognises. npm is the usual
 * answer; MCPB from a GitHub release is the other one, and it is the one that
 * does not require publishing this source to a package registry.
 *
 * The zip is written by hand. The bundle is four small files and the only
 * alternative was a dependency to concatenate them, which for a tool whose
 * whole claim is "no dependencies" would be a poor trade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));
const OUT = path.join(DIST, 'custom-ai-view.mcpb');
const log = m => process.stdout.write(m + '\n');

/* ------------------------------------------------------------------ zip */

/** CRC-32, which is the one thing in a zip entry that cannot be faked. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A zip of stored-or-deflated entries.
 *
 * Deflate is used only when it actually wins: on a file that does not compress,
 * the deflate wrapper is larger than the input, and a zip entry claiming
 * method 8 with a bigger payload is a slower read for no gain.
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // time — fixed, so the build is reproducible
    local.writeUInt16LE(0x21, 12);        // date — 1 Jan 1996, likewise
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 38);             // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* --------------------------------------------------------------- bundle */

/*
 * The server reads its version from ../package.json relative to itself, so the
 * layout has to keep that relationship: server/server.js and a package.json
 * beside it at the root. The manifest's ${__dirname} resolves to wherever the
 * bundle was unpacked.
 */
const manifest = {
  manifest_version: '0.3',
  name: 'custom-ai-view',
  display_name: 'Custom AI View',
  version: pkg.version,
  description: 'See any website as it looks on a real iPhone, iPad, Android phone or MacBook — '
    + 'and drive that same window.',
  long_description: 'A real browser inside pixel-accurate device frames. Open a URL on a chosen '
    + 'device, screenshot the live window with the session still in it rather than a re-render, '
    + 'find and click elements, type, scroll, read markup and computed styles, watch the console '
    + "including the browser's own messages, and record. 73 devices, 70 of them measured in "
    + 'millimetres from published dimensions; bezels derived from body minus panel.\n\n'
    + 'Needs the Custom AI View application on the machine — the server starts it itself if it '
    + 'is not already running. Download it from https://ccustom.ai/view',
  author: { name: 'Custom AI', url: 'https://ccustom.ai' },
  homepage: 'https://ccustom.ai/view',
  documentation: 'https://github.com/ccustomai/custom-ai-view#readme',
  support: 'https://github.com/ccustomai/custom-ai-view/issues',
  license: 'SEE LICENSE IN LICENSE',
  repository: { type: 'git', url: 'https://github.com/ccustomai/custom-ai-view' },
  keywords: ['browser', 'mobile-preview', 'responsive', 'device-frame', 'screenshot', 'iphone', 'ipad'],
  server: {
    type: 'node',
    entry_point: 'server/server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/server.js'] },
  },
  compatibility: { runtimes: { node: '>=18.0.0' } },
};

// Only what the server actually opens. It requires nothing outside node's own
// modules, which is why this bundle is four files rather than a node_modules.
const files = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
  { name: 'server/server.js', data: fs.readFileSync(path.join(ROOT, 'mcp', 'server.js')) },
  { name: 'package.json', data: Buffer.from(JSON.stringify({
    name: 'custom-ai-view',
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    homepage: pkg.homepage,
    // What the registry checks to confirm the package is really this server.
    mcpName: 'io.github.ccustomai/custom-ai-view',
  }, null, 2) + '\n', 'utf8') },
  { name: 'LICENSE', data: fs.readFileSync(path.join(ROOT, 'LICENSE')) },
];

fs.mkdirSync(DIST, { recursive: true });
const buf = zip(files);
fs.writeFileSync(OUT, buf);
const sha = crypto.createHash('sha256').update(buf).digest('hex');

log('built ' + OUT);
files.forEach(f => log('  ' + f.name.padEnd(20) + String(f.data.length).padStart(7) + ' bytes'));
log('');
log('  ' + (buf.length / 1024).toFixed(1) + ' KB');
log('  sha256 ' + sha);
log('');

// server.json carries that hash, and the registry rejects a mismatch — so it is
// written here rather than copied by hand and quietly left one build behind.
const serverJsonPath = path.join(ROOT, 'server.json');
if (fs.existsSync(serverJsonPath)) {
  const sj = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  sj.version = pkg.version;
  sj.packages = [{
    registryType: 'mcpb',
    identifier: 'https://github.com/ccustomai/custom-ai-view/releases/download/v'
      + pkg.version + '/custom-ai-view.mcpb',
    fileSha256: sha,
    transport: { type: 'stdio' },
  }];
  fs.writeFileSync(serverJsonPath, JSON.stringify(sj, null, 2) + '\n', 'utf8');
  log('  server.json updated to match');
}
