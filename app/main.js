#!/usr/bin/env node
/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Custom AI View — entry point.
 *
 * Double-click the exe and you get a device window. Pass a URL to open it straight
 * away, or --device to pick the phone. The process lives as long as a window does.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { spawn } = require('child_process');

const { AppHost, APP_NAME, CONFIG_FILE, LOG_FILE } = require('./host.js');

const HANDSHAKE = path.join(os.homedir(), '.custom-ai-view', 'control.json');

/**
 * Ask the copy that is already running to do it instead.
 *
 * Pressing a pinned icon twice should give a second device window, not a second
 * application. Two of these processes fight: each starts its own servers and each
 * overwrites the handshake file, so whichever wrote last owns the name — and
 * an agent, which finds the app through that file, ends up driving one window while
 * the person is looking at the other.
 */
function askRunningApp(info, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port: info.port,
      path: route,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        authorization: 'Bearer ' + info.token,
      },
      timeout: timeoutMs || 2500,
    }, res => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error('status ' + res.statusCode))));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** @returns {Promise<boolean>} true when a running copy took the job. */
async function handOff(args) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(HANDSHAKE, 'utf8').replace(/^﻿/, ''));
  } catch {
    return false; // never started, or the file went with it
  }
  if (!info || !info.port || !info.token) return false;

  try {
    for (let i = 0; i < args.windows; i++) {
      await askRunningApp(info, '/new-window', { url: args.url, device: args.device });
    }
    return true;
  } catch {
    // A handshake file outlives the process that wrote it, so refusal here is the
    // normal case after a crash or a reboot: start up as if it were not there.
    return false;
  }
}

function parseArgs(argv) {
  const out = { url: '', device: '', windows: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device' || arg === '-d') out.device = argv[++i] || '';
    else if (arg === '--windows' || arg === '-n') out.windows = Math.max(1, Math.min(8, parseInt(argv[++i], 10) || 1));
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (!arg.startsWith('-') && !out.url) out.url = arg;
  }
  return out;
}

const HELP = `
${APP_NAME}

  Preview any page inside a pixel-accurate device frame, in its own desktop window.

Usage
  CustomAIView [url] [options]

Options
  -d, --device <id>    Device to open with, e.g. iphone-16-pro, galaxy-s24
  -n, --windows <n>    Open several windows at once, up to 8
  -h, --help           This text
  -v, --version        Version

Examples
  CustomAIView localhost:5173
  CustomAIView https://example.com --device ipad-pro-11-m4
  CustomAIView localhost:3000 --windows 3

Settings live in ${CONFIG_FILE}
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(require('../package.json').version + '\n');
    return;
  }

  if (await handOff(args)) return;

  const host = new AppHost();
  await host.start();

  for (let i = 0; i < args.windows; i++) {
    await host.openWindow(args.url, args.device);
    if (i < args.windows - 1) await new Promise(r => setTimeout(r, 350));
  }

  const shutdown = () => {
    host.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/*
 * When it cannot start, say so where it can be seen.
 *
 * Launched from the taskbar this process has no console, so stderr goes nowhere: the
 * icon flashes and nothing happens, which is indistinguishable from a click that
 * missed. A message box is the one place a person will actually read, and the log
 * keeps the detail for afterwards.
 */
function reportFatal(message) {
  const text = APP_NAME + ' could not start.\n\n' + message + '\n\nDetails: ' + LOG_FILE;
  try {
    process.stderr.write('\n' + text + '\n\n');
  } catch { /* no console */ }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE,
      '[' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '] FATAL ' + message + '\n');
  } catch { /* nowhere to write */ }

  if (process.platform !== 'win32') return;
  try {
    const quoted = s => "'" + String(s).replace(/'/g, "''") + "'";
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '[System.Windows.Forms.MessageBox]::Show(' + quoted(text) + ', ' + quoted(APP_NAME) + ', ' +
      "'OK', 'Error') | Out-Null",
    ], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } catch { /* the log still has it */ }
}

main().catch(err => {
  reportFatal(err && err.message ? err.message : String(err));
  // Give the message box a moment to appear before the process goes.
  setTimeout(() => process.exit(1), 1500);
});
