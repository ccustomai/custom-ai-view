/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Wrap the built binary into a Mac application.
 *
 * On Windows the single executable IS the app: you double-click the file. macOS
 * does not work that way — a bare Mach-O binary opens a Terminal window, has no
 * icon, cannot be put in the Dock, and Finder treats it as a Unix executable
 * rather than something you launch. What people mean by "a Mac app" is a bundle:
 * a directory with a known shape that Finder, the Dock and Launch Services all
 * read as one thing.
 *
 *   node scripts/build-exe.js        → dist/CustomAIView
 *   node scripts/build-mac-app.js    → dist/Custom AI View.app  (+ a zip)
 *
 * The zip is made with ditto rather than zip: ditto preserves the resource forks
 * and the code signature, and a bundle zipped with anything else arrives on the
 * other machine unsigned and refuses to open.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));

const APP_NAME = 'Custom AI View';
const BUNDLE_ID = 'ai.ccustom.view';
const BINARY = path.join(DIST, 'CustomAIView');
const APP = path.join(DIST, APP_NAME + '.app');

const log = msg => process.stdout.write(msg + '\n');
const run = (cmd, args, opts) => execFileSync(cmd, args, Object.assign({ stdio: 'pipe' }, opts));

if (process.platform !== 'darwin') {
  log('A Mac application can only be assembled on macOS — nothing to do on ' + process.platform + '.');
  log('Build it on a Mac, or let the release workflow do it on a macOS runner.');
  process.exit(0);
}
if (!fs.existsSync(BINARY)) {
  throw new Error('no binary at ' + BINARY + ' — run: node scripts/build-exe.js');
}

// ------------------------------------------------------------------ the icon

/**
 * An .icns from the brand PNG.
 *
 * iconutil wants a folder of PNGs at fixed sizes with fixed names; sips does the
 * resizing. Both ship with macOS, so this needs nothing installed.
 */
function buildIcns(source, target) {
  const iconset = path.join(DIST, 'AppIcon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  // Every size the Finder, the Dock and Get Info ask for, at 1x and 2x.
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), source,
      '--out', path.join(iconset, 'icon_' + size + 'x' + size + '.png')]);
    run('sips', ['-z', String(size * 2), String(size * 2), source,
      '--out', path.join(iconset, 'icon_' + size + 'x' + size + '@2x.png')]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', target]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

// ----------------------------------------------------------------- the bundle

log('assembling ' + APP_NAME + '.app');
fs.rmSync(APP, { recursive: true, force: true });
const contents = path.join(APP, 'Contents');
const macos = path.join(contents, 'MacOS');
const resources = path.join(contents, 'Resources');
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

fs.copyFileSync(BINARY, path.join(macos, 'CustomAIView'));
fs.chmodSync(path.join(macos, 'CustomAIView'), 0o755);

const logo = path.join(ROOT, 'media', 'logo.png');
const icon = fs.existsSync(logo) ? logo : path.join(ROOT, 'media', 'icon.png');
buildIcns(icon, path.join(resources, 'AppIcon.icns'));
log('  icon from ' + path.basename(icon));

/*
 * LSUIElement is deliberately absent: this app opens real windows and belongs in
 * the Dock. NSHighResolutionCapable is what stops the window being drawn at 1x
 * and scaled up — on a frame whose whole point is pixel accuracy, that would be
 * the one bug nobody could see and everybody would feel.
 */
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>CustomAIView</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© 2026 Custom AI. All rights reserved.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleURLSchemes</key><array><string>customaiview</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
fs.writeFileSync(path.join(contents, 'Info.plist'), plist, 'utf8');
fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????', 'utf8');

// The bundle is signed as a whole, after everything is inside it — signing the
// binary alone leaves the bundle unsigned, which is what Gatekeeper checks.
try {
  run('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'inherit' });
  log('  signed ad-hoc');
} catch (err) {
  log('  could not sign: ' + (err.message || err).toString().slice(0, 120));
}

// ------------------------------------------------------------------- the zip

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const zip = path.join(DIST, 'CustomAIView-macos-' + arch + '.zip');
fs.rmSync(zip, { force: true });
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, zip], { stdio: 'inherit' });

log('');
log('  ' + APP);
log('  ' + zip + '  (' + (fs.statSync(zip).size / 1048576).toFixed(1) + ' MB, ' + arch + ')');
log('');
log('  Unzip it into /Applications and open it.');
log('  It is signed ad-hoc, not notarised, so the first launch needs');
log('  right-click → Open, or: xattr -dr com.apple.quarantine "/Applications/' + APP_NAME + '.app"');
log('');
