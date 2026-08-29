/*
 * Register Custom AI View with Windows as a browser.
 *
 *   node scripts/register-browser.js            register
 *   node scripts/register-browser.js --remove   undo
 *
 * Everything is written under HKCU, so no administrator rights are needed and
 * nothing outside this user account is touched.
 *
 * One thing this cannot do, by design: actually make it the default. Since Windows
 * 10 the default-browser choice belongs to the person, not to an installer — there
 * is no supported API to flip it. What this does is put Custom AI View in the list
 * so it can be chosen in Settings → Apps → Default apps.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CustomAIView.exe');
const APP_ID = 'CustomAIView';
const APP_NAME = 'Custom AI View';
const PROG_ID = 'CustomAIViewHTML';

const remove = process.argv.includes('--remove');

if (!remove && !fs.existsSync(EXE)) {
  console.error('Build the app first: node scripts/build-exe.js');
  process.exit(1);
}

function reg(args) {
  try {
    execFileSync('reg.exe', args, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch (err) {
    const text = (err.stderr || err.stdout || '').toString().trim();
    // Deleting a key that was never there is not a failure.
    if (remove && /unable to find|не удается найти/i.test(text)) return true;
    console.error('  reg ' + args.slice(0, 2).join(' ') + ' failed: ' + text);
    return false;
  }
}

const add = (key, value, data, type = 'REG_SZ') =>
  reg(['add', key, ...(value ? ['/v', value] : ['/ve']), '/t', type, '/d', data, '/f']);

const del = key => reg(['delete', key, '/f']);

const CLASSES = 'HKCU\\Software\\Classes';
const CLIENTS = 'HKCU\\Software\\Clients\\StartMenuInternet\\' + APP_ID;
const REGISTERED = 'HKCU\\Software\\RegisteredApplications';

if (remove) {
  console.log('Removing ' + APP_NAME + ' from the browser list…');
  del(CLASSES + '\\' + PROG_ID);
  del(CLIENTS);
  reg(['delete', REGISTERED, '/v', APP_ID, '/f']);
  console.log('Done. Windows may still list it until you sign out and back in.');
  process.exit(0);
}

console.log('Registering ' + APP_NAME + ' as a browser for this user…');
console.log('  ' + EXE);

const command = '"' + EXE + '" "%1"';
let ok = true;

// The document type this app can open, and how to open it.
ok = add(CLASSES + '\\' + PROG_ID, null, APP_NAME + ' HTML Document') && ok;
ok = add(CLASSES + '\\' + PROG_ID + '\\DefaultIcon', null, EXE + ',0') && ok;
ok = add(CLASSES + '\\' + PROG_ID + '\\shell\\open\\command', null, command) && ok;

// The entry Windows reads when it builds the list of installed browsers.
ok = add(CLIENTS, null, APP_NAME) && ok;
ok = add(CLIENTS + '\\DefaultIcon', null, EXE + ',0') && ok;
ok = add(CLIENTS + '\\shell\\open\\command', null, '"' + EXE + '"') && ok;
ok = add(CLIENTS + '\\Capabilities', 'ApplicationName', APP_NAME) && ok;
ok = add(CLIENTS + '\\Capabilities', 'ApplicationIcon', EXE + ',0') && ok;
ok = add(
  CLIENTS + '\\Capabilities',
  'ApplicationDescription',
  'Opens any page inside a pixel-accurate device frame'
) && ok;

for (const scheme of ['http', 'https']) {
  ok = add(CLIENTS + '\\Capabilities\\URLAssociations', scheme, PROG_ID) && ok;
}
for (const ext of ['.htm', '.html']) {
  ok = add(CLIENTS + '\\Capabilities\\FileAssociations', ext, PROG_ID) && ok;
}

// Point Windows at those capabilities.
ok = add(REGISTERED, APP_ID, 'Software\\Clients\\StartMenuInternet\\' + APP_ID + '\\Capabilities') && ok;

console.log('');
if (!ok) {
  console.error('Some registry writes failed — see above.');
  process.exit(1);
}

console.log(APP_NAME + ' is now in the list of browsers.');
console.log('');
console.log('Windows will not let a program make itself the default — that choice is');
console.log('yours to make, once:');
console.log('');
console.log('  Settings → Apps → Default apps → Custom AI View → "Set default"');
console.log('');
console.log('Or open it directly:  start ms-settings:defaultapps');
console.log('Undo any time with:   node scripts/register-browser.js --remove');
