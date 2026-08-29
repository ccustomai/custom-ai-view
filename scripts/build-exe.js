/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Build CustomAIView.exe.
 *
 * Node's Single Executable Application feature takes one bundled script and one blob
 * and injects both into a copy of node.exe. Everything the app reads from disk —
 * the media, the window shell, the device catalogue — is deflated into that blob and
 * unpacked to a cache folder on first run, so the result really is one file you can
 * move anywhere.
 *
 *   node scripts/build-exe.js
 *
 * Needs esbuild and postject, both fetched through npx on demand.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));

// `.exe` is a Windows convention. Elsewhere the extension is noise, and on macOS a
// name ending in .exe inside an .app bundle stops it being the bundle executable.
const EXE_NAME = process.platform === 'win32' ? 'CustomAIView.exe' : 'CustomAIView';

/** Everything the running app opens by path rather than by require(). */
const RESOURCES = [
  'app/window.html',
  'src/devices.js',
  'media/main.js',
  'media/frame.js',
  'media/ui.css',
  'media/frames.css',
  'media/inject.js',
  'media/shot.html',
  'media/shot.js',
  'media/start.html',
  'media/start.css',
  'media/start.js',
  'media/icon.png',
  'media/logo.png',
  'media/activity.svg',
];

const log = msg => process.stdout.write(msg + '\n');

function npx(args, opts) {
  const win = process.platform === 'win32';
  // Node refuses to spawn a .cmd without a shell, so on Windows the arguments have
  // to be quoted by hand — paths here contain spaces.
  const quoted = win ? args.map(a => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)) : args;
  return execFileSync(win ? 'npx.cmd' : 'npx', quoted, Object.assign({
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    shell: win,
  }, opts));
}

function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ------------------------------------------------------------ 1. resources

log('collecting resources');
clean(BUILD);

const payload = { version: pkg.version, files: {} };
for (const rel of RESOURCES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error('missing resource: ' + rel);
  payload.files[rel] = fs.readFileSync(file).toString('base64');
}

// Keyed by content, not by version: two builds of the same version have different
// files, and unpacking to a version-named folder would silently reuse the old ones.
payload.stamp = require('crypto')
  .createHash('sha256')
  .update(JSON.stringify(payload.files))
  .digest('hex')
  .slice(0, 12);

const packed = zlib.deflateSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
fs.writeFileSync(path.join(BUILD, 'resources.bin'), packed);
log('  ' + RESOURCES.length + ' files, ' + (packed.length / 1024).toFixed(0) + ' KB compressed');

// ------------------------------------------------------------- 2. bootstrap

log('writing bootstrap');
fs.writeFileSync(path.join(BUILD, 'entry.js'), `
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const paths = require(${JSON.stringify(path.join(ROOT, 'src', 'paths.js').replace(/\\/g, '/'))});

/*
 * Unpack the resources carried inside the binary. They go to a per-version folder,
 * so a new build never reads a stale file and an old build keeps working.
 */
function unpack() {
  let sea;
  try {
    sea = require('node:sea');
  } catch {
    return; // running from source
  }
  if (!sea.isSea || !sea.isSea()) return;

  const raw = Buffer.from(sea.getRawAsset('resources'));
  const payload = JSON.parse(zlib.inflateSync(raw).toString('utf8'));
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || os.tmpdir();
  const dir = path.join(base, 'CustomAIView', 'resources', payload.version + '-' + payload.stamp);

  const stamp = path.join(dir, '.complete');
  if (!fs.existsSync(stamp)) {
    for (const [rel, b64] of Object.entries(payload.files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    }
    fs.writeFileSync(stamp, payload.version + ' ' + payload.stamp);
  }
  paths.setRoot(dir);

  // Older unpacked copies are dead weight once this build runs.
  try {
    const parent = path.dirname(dir);
    for (const entry of fs.readdirSync(parent)) {
      if (entry !== path.basename(dir)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    }
  } catch {
    /* tidying is optional */
  }
}

unpack();
require(${JSON.stringify(path.join(ROOT, 'app', 'main.js').replace(/\\/g, '/'))});
`);

// -------------------------------------------------------------- 3. bundle

log('bundling with esbuild');
npx([
  '--yes', 'esbuild@0.24.0',
  path.join(BUILD, 'entry.js'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  '--external:node:sea',
  '--outfile=' + path.join(BUILD, 'app.bundle.js'),
]);
log('  bundle: ' + (fs.statSync(path.join(BUILD, 'app.bundle.js')).size / 1024).toFixed(0) + ' KB');

// ----------------------------------------------------------------- 4. sea

log('preparing the SEA blob');
const seaConfig = {
  main: path.join(BUILD, 'app.bundle.js'),
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { resources: path.join(BUILD, 'resources.bin') },
};
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], {
  cwd: ROOT,
  stdio: 'inherit',
});

// ----------------------------------------------------------------- 5. exe

log('assembling the executable');
fs.mkdirSync(DIST, { recursive: true });
const exe = path.join(DIST, EXE_NAME);
fs.copyFileSync(process.execPath, exe);

// Windows refuses to run a binary whose signature no longer matches its contents.
if (process.platform === 'win32') {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$sig = Get-AuthenticodeSignature -FilePath '" + exe.replace(/'/g, "''") + "';" +
      "if ($sig.Status -ne 'NotSigned') { Write-Output 'signed' } else { Write-Output 'unsigned' }",
    ], { stdio: 'pipe', windowsHide: true });
  } catch {
    /* signature inspection is advisory */
  }
}

/*
 * macOS ships node signed, and injecting a section invalidates that signature —
 * the result is killed on launch with SIGKILL and no message anyone can act on.
 * The signature is therefore removed before the injection and an ad-hoc one is
 * applied after. Ad-hoc is enough to run; distributing it outside the Mac App
 * Store still wants a Developer ID signature and notarisation, which needs an
 * Apple account rather than a build step.
 *
 * Mach-O also has no spare section to write into, so the blob goes in a segment
 * of its own — which is what --macho-segment-name names.
 */
const mac = process.platform === 'darwin';
if (mac) {
  try {
    execFileSync('codesign', ['--remove-signature', exe], { stdio: 'pipe' });
    log('  signature removed before injection');
  } catch {
    /* an unsigned node is fine — there is nothing to remove */
  }
}

npx([
  '--yes', 'postject@1.0.0-alpha.6',
  exe, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
].concat(mac ? ['--macho-segment-name', 'NODE_SEA'] : []));

if (mac) {
  execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
  log('  re-signed ad-hoc');
}

// A build interrupted between copying node.exe and injecting the blob leaves a
// plain node binary that treats its first argument as a script path. Prove the
// finished file is really the app before calling it built.
log('verifying');
const reported = execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (reported !== pkg.version) {
  throw new Error(
    'the executable did not report version ' + pkg.version + ' (got "' + reported + '"). ' +
    'The SEA blob is missing or was not injected — rerun the build.'
  );
}
log('  reports version ' + reported);

/*
 * Take the console window away.
 *
 * A single executable is a copy of node.exe, and node.exe is a console program:
 * double-click it and Windows opens a black window beside the device — pinned to a
 * taskbar it looks broken. The subsystem field in the PE header is what decides
 * that, and flipping it from console (3) to GUI (2) is a two-byte edit. It happens
 * after the version check on purpose: that check reads the program's own output,
 * which is easiest while it still has somewhere to write it. A piped or inherited
 * handle still works afterwards, so the diagnostics keep working; only the window
 * nobody asked for goes away.
 */
function makeWindowless(file) {
  const buf = fs.readFileSync(file);
  const peAt = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peAt) !== 0x00004550) throw new Error('not a PE file: ' + file);

  // The subsystem sits 68 bytes into the optional header, in both PE32 and PE32+.
  const subsystemAt = peAt + 4 + 20 + 68;
  const current = buf.readUInt16LE(subsystemAt);
  if (current === 2) return false;
  if (current !== 3) throw new Error('unexpected Windows subsystem ' + current + ' — refusing to patch');

  buf.writeUInt16LE(2, subsystemAt);
  fs.writeFileSync(file, buf);
  return true;
}

if (process.platform === 'win32' && makeWindowless(exe)) {
  log('  no console window (subsystem set to GUI)');
}

const size = fs.statSync(exe).size;
log('');
log('  built ' + exe);
log('  ' + (size / 1024 / 1024).toFixed(1) + ' MB');
log('');
log('  Run it:      ' + EXE_NAME);
log('  With a URL:  ' + EXE_NAME + ' localhost:5173');
log('  Two windows: ' + EXE_NAME + ' localhost:5173 --windows 2');
log('');
