/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Putting an image on the system clipboard.
 *
 * VS Code's clipboard API is text-only, so this shells out to whatever the platform
 * provides. On Windows the data object carries both the bitmap and a file drop, so a
 * paste works in chat apps (image) and in file dialogs (path) alike.
 */
'use strict';

const { spawn } = require('child_process');

function run(command, args, input) {
  return new Promise(resolve => {
    let proc;
    try {
      proc = spawn(command, args, { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', err => resolve({ ok: false, error: err.message }));
    proc.on('close', code => resolve({ ok: code === 0, error: stderr.trim() || ('exit ' + code) }));
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

// The path is embedded rather than passed as an argument: with -Command, PowerShell
// treats everything after the script as part of the command, so $args stays empty.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = __PATH__
$data = New-Object System.Windows.Forms.DataObject
$stream = [System.IO.File]::OpenRead($path)
try {
  $img = [System.Drawing.Image]::FromStream($stream)
  $data.SetImage($img)
} finally { $stream.Dispose() }
$files = New-Object System.Collections.Specialized.StringCollection
$files.Add($path) | Out-Null
$data.SetFileDropList($files)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`;

/**
 * @param {string} file absolute path to a PNG or GIF already written to disk
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function copyImage(file) {
  if (process.platform === 'win32') {
    // A single-quoted PowerShell literal, with embedded quotes doubled.
    const literal = "'" + String(file).replace(/'/g, "''") + "'";
    const script = PS_SCRIPT.replace('__PATH__', literal);
    // -sta is required: the Windows clipboard is single-threaded apartment only.
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-sta', '-Command', script]);
  }

  if (process.platform === 'darwin') {
    const kind = file.toLowerCase().endsWith('.gif') ? 'GIFf' : 'PNGf';
    return run('osascript', [
      '-e',
      `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class ${kind}»)`,
    ]);
  }

  const type = file.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/png';
  const wl = await run('wl-copy', ['--type', type, '--', file]);
  if (wl.ok) return wl;
  return run('xclip', ['-selection', 'clipboard', '-t', type, '-i', file]);
}

module.exports = { copyImage };
