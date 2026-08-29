/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Something to pin to the taskbar.
 *
 * The executable alone is enough to run the app, but a pinned button is judged by
 * its icon, and a bare SEA binary carries node's. Rather than rewrite the resource
 * section of the exe — the fiddliest part of the PE format, and one bad offset from
 * a file Windows refuses to load — the icon is put where the taskbar actually reads
 * it from: the shortcut.
 *
 *   node scripts/make-launcher.js            → Desktop
 *   node scripts/make-launcher.js --here     → next to the exe, in dist/
 *
 * Then right-click the shortcut and choose "Pin to taskbar".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'CustomAIView.exe');
const ICO = path.join(DIST, 'CustomAIView.ico');
const APP_NAME = 'Custom AI View';

const log = msg => process.stdout.write(msg + '\n');

/**
 * An icon file wrapping the brand PNGs.
 *
 * Windows has read PNG-bodied icons since Vista, so the images go in untouched —
 * no decoding, no palette, and no loss. Several sizes are listed because the
 * taskbar, the window corner and Alt-Tab all ask for different ones, and letting
 * Windows pick beats making it downscale a single large image.
 */
function buildIco(sources, target) {
  const images = [];
  for (const src of sources) {
    if (!fs.existsSync(src)) continue;
    const png = fs.readFileSync(src);
    if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + src);
    // Width and height live in the IHDR chunk, which is always first.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width > 256 || height > 256) throw new Error('icons cannot exceed 256 px: ' + src);
    images.push({ png, width, height });
  }
  if (!images.length) throw new Error('no source images found');

  // Largest first, which is the order Windows expects to find them in.
  images.sort((a, b) => b.width - a.width);

  const HEADER = 6;
  const ENTRY = 16;
  const dir = Buffer.alloc(HEADER + ENTRY * images.length);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // 1 = icon, 2 would be a cursor
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const at = HEADER + ENTRY * i;
    // 256 is written as 0: the field is one byte, and 256 does not fit in it.
    dir.writeUInt8(img.width === 256 ? 0 : img.width, at + 0);
    dir.writeUInt8(img.height === 256 ? 0 : img.height, at + 1);
    dir.writeUInt8(0, at + 2);          // colours in palette — none, it is truecolour
    dir.writeUInt8(0, at + 3);          // reserved
    dir.writeUInt16LE(1, at + 4);       // colour planes
    dir.writeUInt16LE(32, at + 6);      // bits per pixel
    dir.writeUInt32LE(img.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });

  fs.writeFileSync(target, Buffer.concat([dir, ...images.map(i => i.png)]));
  return images.map(i => i.width + '×' + i.height);
}

/** The real Desktop, which OneDrive and localised installs both move. */
function desktopDir() {
  const home = os.homedir();
  const candidates = [
    process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'),
    path.join(home, 'Desktop'),
    path.join(home, 'Рабочий стол'),
    path.join(home, 'OneDrive', 'Desktop'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* try the next */
    }
  }
  return home;
}

function makeShortcut(linkPath) {
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$s = $ws.CreateShortcut(' + q(linkPath) + ')',
    '$s.TargetPath = ' + q(EXE),
    '$s.WorkingDirectory = ' + q(path.dirname(EXE)),
    '$s.IconLocation = ' + q(ICO + ',0'),
    '$s.Description = ' + q('Preview any page inside a real device frame'),
    '$s.WindowStyle = 1',
    '$s.Save()',
  ].join('; ');

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

// ---------------------------------------------------------------------------

if (process.platform !== 'win32') {
  log('This makes a Windows shortcut; nothing to do on ' + process.platform + '.');
  process.exit(0);
}
if (!fs.existsSync(EXE)) {
  throw new Error('no executable at ' + EXE + ' — run: node scripts/build-exe.js');
}

const sizes = buildIco([
  path.join(ROOT, 'media', 'logo.png'),
  path.join(ROOT, 'media', 'icon.png'),
], ICO);
log('icon: ' + path.basename(ICO) + '  (' + sizes.join(', ') + ')');

const target = process.argv.includes('--here') ? DIST : desktopDir();
const link = path.join(target, APP_NAME + '.lnk');
makeShortcut(link);

log('shortcut: ' + link);
log('');
log('  Right-click it and choose "Pin to taskbar" — or drag it onto the taskbar.');
log('  One press opens a device window. Press it again for a second window:');
log('  the app hands the request to the copy already running instead of starting another.');
log('');
