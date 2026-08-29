/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Custom AI View — standalone host.
 *
 * The same device frames and the same proxy as the VS Code extension, but running as
 * its own desktop app: each preview is a real OS window (a Chrome app window), so you
 * can put an iPhone and an iPad side by side on the desktop.
 *
 * The UI is the extension's own webview code, unchanged. It talks to a webview API
 * shim instead of VS Code's: messages up over POST, messages down over an
 * EventSource stream. That keeps one implementation of the panel, not two.
 *
 * Because every window is a real Chrome page, an AI agent can attach to it over the
 * DevTools protocol and see exactly what you see — not a re-render of it.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { PreviewProxy, probeFraming, discoverDevServers, UA } = require('../src/proxy.js');
const { Capturer } = require('../src/capture.js');
const { copyImage } = require('../src/clipboard.js');
const { ControlServer } = require('../src/control.js');
const { CdpSession, findChrome, sweepAbandonedTemp } = require('../src/cdp.js');
const { detect: detectDisplay } = require('../src/display.js');
const { Library } = require('../src/library.js');
const { DEVICES, byId, oriented, pointerFor } = require('../src/devices.js');

const paths = require('../src/paths.js');
const APP_NAME = 'Custom AI View';
const APP_VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '';
  }
})();

const COMMON_PORTS = [
  887,
  3000, 3001, 3002, 4000, 4200, 4321, 5000, 5001, 5173, 5174, 5175,
  8000, 8080, 8081, 8100, 8888, 9000, 1313, 1234, 7357,
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const isMixedContent = url => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && !LOOPBACK.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
};

// --------------------------------------------------------------- settings

const CONFIG_DIR = path.join(os.homedir(), '.custom-ai-view');
// Overridable so a test run never reads or writes the settings you are actually using.
const CONFIG_FILE = process.env.DP_SETTINGS_FILE || path.join(CONFIG_DIR, 'settings.json');
// Where the app says what happened. Started as a console the taskbar then took away.
const LOG_FILE = path.join(CONFIG_DIR, 'app.log');
// Visited URLs. Their own file: they are not settings, and they carry tokens.
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');

const DEFAULT_SETTINGS = {
  defaultDevice: 'iphone-16-pro',
  startUrl: '',
  clock: 'real',
  customClock: '9:41',
  statusBarStyle: 'auto',
  statusBarLayout: 'inset',
  browserChrome: false,
  deviceFinish: 'graphite',
  background: 'studio',
  shadow: true,
  showLabel: true,
  zoom: 'fit',
  touchEmulation: 'always',
  gridDevices: ['iphone-se-3', 'iphone-16-pro', 'galaxy-s24', 'ipad-pro-11-m4'],
  forceMobileViewport: false,
  chromePath: '',
  captureDirectory: '',
  calibration: 1,
  // Ports to look for besides whatever the machine reports listening, e.g. [887].
  extraPorts: [],
  // Whether the camera button takes the whole device or only its screen. The AI is
  // given the framed one either way — it is the picture that shows the notch, the
  // safe areas and how much of the page a phone actually fits.
  framedShots: true,
  /*
   * The port the proxy listens on.
   *
   * Left at 0 it takes whatever is free, and since browser storage is keyed by
   * origin — scheme, host AND port — every launch is a different origin: a new
   * empty localStorage, so you sign in again, every time. A fixed port keeps the
   * session; if it is taken, the app falls back to an ephemeral one.
   */
  proxyPort: 7358,
  // 'system' follows Windows; 'dark' and 'light' pin it.
  theme: 'system',
  // Where the Elements/Console drawer sits, and the size it was dragged to.
  devtoolsDock: 'right',
  devtoolsWidth: 0,
  devtoolsHeight: 0,
  // Per-platform user-agent overrides, e.g. { "ios": "Mozilla/5.0 (Macintosh; …)" }.
  // Empty means the real phone's, which is what you want until a site misbehaves
  // when it believes it is on one.
  userAgent: {},
};

function loadSettings() {
  try {
    // Editors and PowerShell both like to write UTF-8 with a byte-order mark, and
    // JSON.parse rejects one — which would silently throw the file away.
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(text));
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write('settings.json could not be read (' + err.message + '), using defaults\n');
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  } catch {
    /* settings are a convenience, never a hard failure */
  }
}

// ---------------------------------------------------------------- session

/** One preview window: its own device, its own page, its own message stream. */
class Session {
  constructor(id, host) {
    this.id = id;
    this.host = host;
    this.clients = new Set();
    this.backlog = [];
    this.currentUrl = '';
    /*
     * Resolves once the window has loaded and taken its first URL.
     *
     * Opening a window is not instant — Chrome has to start, the shell has to
     * connect, the page has to navigate. Without something to wait on, a caller is
     * told "opened" while the window is still blank, and anything it does next
     * (a screenshot, a query) describes nothing.
     */
    this.ready = new Promise(resolve => {
      this.markReady = resolve;
    });
    this.selection = null;
    this.consoleLog = [];
    this.history = [];
    this.title = APP_NAME;
    this.cdp = null;
    this.state = {
      deviceId: host.settings.defaultDevice,
      orientation: 'portrait',
      zoom: host.settings.zoom,
      mode: 'single',
      custom: { w: 400, h: 800, dpr: 2 },
      touchEmulation: host.settings.touchEmulation,
    };
  }

  post(message) {
    const payload = 'data: ' + JSON.stringify(message) + '\n\n';
    if (!this.clients.size) {
      // The window is between streams — reconnecting, or not listening yet. Hold the
      // message rather than dropping it; a lost "init" leaves an empty window.
      this.backlog.push(payload);
      if (this.backlog.length > 200) this.backlog.splice(0, this.backlog.length - 200);
      return;
    }
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Hand a freshly connected stream whatever it missed. */
  drain(res) {
    if (!this.backlog.length) return;
    const pending = this.backlog;
    this.backlog = [];
    for (const payload of pending) {
      try {
        res.write(payload);
      } catch {
        return;
      }
    }
  }

  get device() {
    return oriented(byId(this.state.deviceId), this.state.orientation, this.state.custom);
  }
}

// ------------------------------------------------------------------- host

class AppHost {
  constructor() {
    AppHost.rotateLog();
    this.settings = loadSettings();
    this.sessions = new Map();
    this.server = null;
    this.port = 0;
    this.chromeProcs = new Set();
    this.chromePort = 0;
    this.displayMetrics = null;
    this.profileDir = path.join(CONFIG_DIR, 'window-profile');

    this.proxy = new PreviewProxy({
      mediaDir: paths.resolve('media'),
      log: msg => this.log('proxy: ' + msg),
      // Keeping the same port keeps the previewed site's storage, and with it the
      // login. See proxyPort in the settings.
      port: this.settings.proxyPort || 0,
      stateFile: path.join(CONFIG_DIR, 'proxy-state.json'),
    });

    this.library = new Library({
      root: this.settings.captureDirectory || '',
      log: msg => this.log('library: ' + msg),
    });

    this.capturer = new Capturer({
      proxy: this.proxy,
      log: msg => this.log('capture: ' + msg),
      chromePath: this.settings.chromePath,
      library: this.library,
    });

    this.control = null;
  }

  log(message) {
    const line = '[' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '] ' + message + '\n';
    // Launched from the taskbar there is no console at all, and writing to a handle
    // that was never opened must not be what stops the app.
    try {
      process.stdout.write(line);
    } catch {
      /* nobody is reading */
    }
    /*
     * And to a file, because the console is where this used to go and the taskbar
     * took it away. Without this, "it did not work" has nothing behind it: no
     * message, no trace, nothing the owner could send to anyone.
     *
     * The first line carries a byte-order mark. The log is UTF-8 and holds URLs and
     * error text that are often Cyrillic; Notepad and PowerShell on a Russian Windows
     * read a file without one as the system codepage, and turn all of it into mojibake
     * — a log nobody can read is not much better than no log.
     */
    try {
      const first = !fs.existsSync(LOG_FILE);
      fs.appendFileSync(LOG_FILE, (first ? '﻿' : '') + line, 'utf8');
    } catch {
      /* a log that cannot be written must not be what stops the app either */
    }
  }

  /** Keep the log from growing without end; the previous one is kept as .old. */
  static rotateLog() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    } catch {
      /* no log yet, or nowhere to put one */
    }
  }

  async start() {
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.route(req, res).catch(err => {
          this.log('request failed: ' + (err && err.stack ? err.stack : err));
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err && err.message ? err.message : err));
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });

    await this.proxy.start();
    await this.startControlApi();

    /*
     * Take out the litter before doing anything else.
     *
     * A capture that was interrupted — the app killed, the machine restarted —
     * leaves its throwaway Chrome profile behind, and nothing else on the system
     * will ever remove it. On this machine thirty-five of them had accumulated
     * over four days and come to half a gigabyte. Doing it at startup rather
     * than only before the next capture means it also happens for someone who
     * never takes one.
     */
    sweepAbandonedTemp(msg => this.log(msg));

    // Physical panel size, so a device can be drawn at its true size.
    try {
      const info = await detectDisplay();
      this.displayMetrics = info.primary;
      if (info.primary) {
        this.log('display: ' + info.primary.widthMm + '×' + info.primary.heightMm + ' mm, ' +
          info.primary.dpi + ' dpi');
      }
    } catch {
      this.displayMetrics = null;
    }

    this.log(APP_NAME + ' listening on http://127.0.0.1:' + this.port);
    return this.port;
  }

  get origin() {
    return 'http://127.0.0.1:' + this.port;
  }

  // ------------------------------------------------------------- routing

  async route(req, res) {
    if (req.headers.host && !/^127\.0\.0\.1:/.test(req.headers.host)) {
      res.writeHead(404);
      return res.end();
    }

    const url = new URL(req.url, this.origin);
    const route = url.pathname;

    if (route === '/' || route === '/window') return this.serveWindow(url, res);
    if (route === '/events') return this.serveEvents(url, req, res);
    if (route === '/message') return this.receiveMessage(url, req, res);
    if (route === '/favicon.ico') return this.serveFile(paths.resolve('media', 'icon.png'), res);

    // basename() is what keeps a crafted path from walking out of the media folder.
    if (route.startsWith('/media/')) {
      return this.serveFile(paths.resolve('media', path.basename(route)), res);
    }
    if (route === '/src/devices.js') {
      return this.serveFile(paths.resolve('src', 'devices.js'), res);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  serveFile(file, res) {
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  serveWindow(url, res) {
    const id = url.searchParams.get('id') || this.newSessionId();
    if (!this.sessions.has(id)) this.sessions.set(id, new Session(id, this));

    const html = fs.readFileSync(paths.resolve('app', 'window.html'), 'utf8')
      .replace(/__SESSION_ID__/g, id)
      .replace(/__APP_NAME__/g, APP_NAME);

    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(html);
  }

  serveEvents(url, req, res) {
    const session = this.sessions.get(url.searchParams.get('id'));
    if (!session) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    session.clients.add(res);
    session.drain(res);

    // Proxies and idle timeouts kill silent streams; a comment every 20s keeps it open.
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(beat);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(beat);
      session.clients.delete(res);
      // A window that has gone away should not keep the app alive.
      setTimeout(() => this.reapSession(session), 1500);
    });
  }

  async receiveMessage(url, req, res) {
    const session = this.sessions.get(url.searchParams.get('id'));
    if (!session) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"no such window"}');
    }
    const body = await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    try {
      await this.onMessage(session, body);
    } catch (err) {
      this.log('message ' + body.type + ' failed: ' + (err && err.stack ? err.stack : err));
    }
  }

  newSessionId() {
    return crypto.randomBytes(6).toString('hex');
  }

  reapSession(session) {
    if (session.clients.size) return;
    this.sessions.delete(session.id);
    this.log('window ' + session.id + ' closed (' + this.sessions.size + ' left)');
    if (!this.sessions.size) {
      this.log('last window closed, shutting down');
      this.stop();
      process.exit(0);
    }
  }

  // ------------------------------------------------------ webview protocol

  async onMessage(session, msg) {
    switch (msg.type) {
      case 'ready': {
        session.post({
          type: 'init',
          devices: DEVICES,
          state: session.state,
          config: Object.assign({}, this.settings, {
            display: this.displayMetrics,
            libraryRoot: this.library.root,
            // So "which build am I looking at" has an answer, and so does "where do
            // I look when it breaks".
            version: APP_VERSION,
            logFile: LOG_FILE,
          }),
          history: this.history(),
        });
        /*
         * currentUrl is in here for a reason. A caller can reach /open before the
         * window has finished announcing itself — the control API answers long before
         * Chrome does. That navigation lands in the backlog, and if "ready" then fell
         * through to the start page, it overwrote the page the caller had just asked
         * for: the window sat on the start screen while /state cheerfully reported the
         * requested URL. Re-navigating to what was already asked for costs one load
         * and removes the race entirely.
         */
        const initial = session.pendingUrl || session.currentUrl || this.settings.startUrl || '';
        session.pendingUrl = null;
        if (initial) await this.navigate(session, initial);
        else session.post({ type: 'start-page' });
        session.markReady(session);
        this.refreshPorts(session);
        // Attach now rather than when something first needs a screenshot, or the
        // browser's own messages about this page are missed exactly when they matter:
        // during the load that went wrong.
        this.attach(session).catch(() => { /* not inspectable; the shim still reports */ });
        break;
      }
      case 'navigate':
        await this.navigate(session, msg.url, msg.force);
        break;
      case 'state': {
        Object.assign(session.state, msg.state || {});
        // Some of this describes the machine and the person, not one window, and is
        // expected to still be true tomorrow: the calibration of the monitor, the
        // theme, where the drawer sits and how big it was dragged.
        const sticky = {};
        if (typeof msg.state.calibration === 'number' && msg.state.calibration > 0) {
          sticky.calibration = msg.state.calibration;
        }
        /*
         * Everything chosen in the toolbar is a preference, not a property of this
         * window. Only the calibration used to survive a restart, so opening on an
         * iPad instead of an iPhone meant editing JSON by hand — every time, forever.
         */
        const remembered = {
          deviceId: 'defaultDevice',
          finish: 'deviceFinish',
          statusBar: 'statusBarStyle',
          statusBarLayout: 'statusBarLayout',
          clock: 'clock',
          customClock: 'customClock',
          pointerStyle: 'pointerStyle',
          background: 'background',
          shadow: 'shadow',
          glare: 'glare',
          showLabel: 'showLabel',
          zoom: 'zoom',
          browserChrome: 'browserChrome',
          touchEmulation: 'touchEmulation',
          gridDevices: 'gridDevices',
          framedShots: 'framedShots',
          theme: 'theme',
          devtoolsDock: 'devtoolsDock',
          devtoolsWidth: 'devtoolsWidth',
          devtoolsHeight: 'devtoolsHeight',
        };
        for (const [from, to] of Object.entries(remembered)) {
          const value = msg.state[from];
          if (value === undefined || value === null || value === '') continue;
          // An array compares by contents; everything else compares by value.
          if (Array.isArray(value)) {
            if (JSON.stringify(value) !== JSON.stringify(this.settings[to])) sticky[to] = value.slice();
          } else {
            sticky[to] = value;
          }
        }

        const changed = Object.keys(sticky).filter(k => this.settings[k] !== sticky[k]);
        if (changed.length) {
          Object.assign(this.settings, sticky);
          saveSettings(this.settings);
        }
        break;
      }
      case 'navigated':
        session.currentUrl = msg.url;
        if (msg.title) session.title = msg.title;
        this.remember(msg.url);
        break;
      case 'device-changed':
        session.state.deviceId = msg.deviceId;
        session.state.orientation = msg.orientation;
        break;
      case 'open-external':
        this.openExternal(msg.url);
        break;
      case 'copy':
        // The window itself owns the clipboard; ask it to do the write.
        session.post({ type: 'clipboard-text', text: msg.text });
        break;
      case 'scan-ports':
        this.refreshPorts(session);
        break;
      case 'hard-reload':
        this.proxy.bypassCache(8000);
        await this.navigate(session, msg.url || session.currentUrl, undefined, { cacheBust: true });
        break;
      case 'purge':
        this.proxy.clearState();
        this.proxy.bypassCache(10000);
        break;
      case 'capture':
        await this.capture(session, msg);
        break;
      case 'record':
        await this.record(session, msg);
        break;
      case 'element-for-ai':
        await this.elementForAI(session, msg);
        break;
      case 'selection':
        session.selection = msg.element;
        break;
      case 'console':
        for (const entry of msg.entries || []) session.consoleLog.push(Object.assign({ at: Date.now() }, entry));
        if (session.consoleLog.length > 400) session.consoleLog.splice(0, session.consoleLog.length - 400);
        break;
      case 'new-window':
        await this.openWindow(msg.url || session.currentUrl, msg.device || session.state.deviceId);
        break;
      case 'record-start':
        try {
          await this.capturer.startRecording(this.captureOptions(session, msg));
          session.post({ type: 'recording-state', recording: true, seconds: 0, libraryRoot: this.library.root });
        } catch (err) {
          session.post({ type: 'captured', error: String(err.message) });
          session.post({ type: 'recording-state', recording: false });
        }
        break;
      case 'record-stop':
        try {
          const clip = await this.capturer.stopRecording();
          session.post({ type: 'recording-state', recording: false });
          session.post({
            type: 'captured', kind: 'recording', file: clip.file,
            frames: clip.frames, fps: clip.fps, seconds: clip.seconds,
            clipboard: (await copyImage(clip.file)).ok,
          });
        } catch (err) {
          session.post({ type: 'recording-state', recording: false });
          session.post({ type: 'captured', error: String(err.message) });
        }
        break;
      case 'collect':
        try {
          await this.collect(session, msg);
        } catch (err) {
          session.post({ type: 'captured', error: String(err.message) });
        }
        break;
      case 'open-site-folder': {
        const dir = this.library.siteDir(session.currentUrl);
        try {
          require('fs').mkdirSync(dir, { recursive: true });
        } catch { /* the opener will report it */ }
        this.openPath(dir);
        break;
      }
      case 'open-path':
        this.openPath(msg.path);
        break;
      case 'choose-library-root': {
        const picked = await this.chooseFolder(this.library.root);
        if (!picked) break;
        this.library.setRoot(picked);
        this.settings.captureDirectory = picked;
        saveSettings(this.settings);
        for (const s of this.sessions.values()) s.post({ type: 'library-root', root: picked });
        this.log('material is now filed under ' + picked);
        break;
      }
      case 'revert-edits': {
        const cleared = this.proxy.clearEdits();
        session.post({ type: 'command', name: 'reload', payload: { mode: 'normal' } });
        this.log('reverted ' + cleared + ' live edit(s)');
        break;
      }
      case 'error':
        this.log('[window] ' + msg.message);
        break;
      default:
        break;
    }
  }

  /*
   * Where you have been, kept apart from what you have configured.
   *
   * It used to live in settings.json, which is the file the documentation tells you
   * to open and the file you would paste to ask someone for help — and forty visited
   * URLs is not a neutral list: a magic-link verification token and an OAuth callback
   * are both just URLs, and both were sitting in it. Its own file, readable only by
   * this account, and settings.json goes back to being nineteen lines you can read.
   */
  remember(url) {
    if (!url || url.startsWith('data:')) return;
    const list = this.history().filter(u => u !== url);
    list.unshift(url);
    this._history = list.slice(0, 40);
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this._history, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log('could not save history: ' + err.message);
    }
  }

  history() {
    if (this._history) return this._history;
    // Anything the old builds left behind moves across once, then never again.
    let carried = Array.isArray(this.settings.history) ? this.settings.history : [];
    if (carried.length) {
      delete this.settings.history;
      saveSettings(this.settings);
      this.log('moved ' + carried.length + ' history entries out of settings.json');
    }
    try {
      const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(saved)) carried = saved.concat(carried.filter(u => !saved.includes(u)));
    } catch {
      /* none yet */
    }
    this._history = carried.slice(0, 40);
    return this._history;
  }

  async refreshPorts(session) {
    try {
      /*
       * Ask the machine what is listening, then ask each one whether it serves pages.
       * The old fixed list was a guess that missed a dev server on any port nobody
       * thought of — which is exactly how "it does not see my server" happens.
       */
      const extra = (this.settings.extraPorts || [])
        .map(p => parseInt(p, 10))
        .filter(p => p > 0 && p < 65536);
      const found = await discoverDevServers(extra);

      /*
       * The icons come through the proxy.
       *
       * A dev server on https uses a certificate nothing trusts, and a browser will
       * not load an image from it — and inside a frame there is no interstitial to
       * click through. The proxy already terminates TLS for loopback and answers in
       * plain http, so routing the icon through it is the difference between the
       * https servers showing their logo and showing a grey dot.
       */
      await this.proxy.start();
      const ports = found.map(s => Object.assign({}, s, {
        icon: s.icon ? this.proxy.wrap(s.icon) : '',
      }));
      session.post({ type: 'ports', ports });
    } catch {
      /* the scan is a convenience */
    }
  }

  normalize(input) {
    let raw = String(input || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    if (/^(mailto|tel|sms|data|about):/i.test(raw)) return raw;
    if (/^\d{2,5}$/.test(raw)) return 'http://localhost:' + raw;
    if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(raw)) return 'http://' + raw;
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) return 'file:///' + raw.replace(/\\/g, '/').replace(/^\//, '');
    return 'https://' + raw;
  }

  async navigate(session, input, force, opts) {
    const url = this.normalize(input);
    if (!url) return;

    if (!/^https?:/i.test(url)) {
      session.currentUrl = url;
      session.post({ type: 'load', url, real: url, proxied: false, kind: 'other' });
      return;
    }

    const mode = force || session.state.touchEmulation || this.settings.touchEmulation || 'always';
    let useProxy = mode === 'always';
    let reason = '';

    if (isMixedContent(url)) {
      useProxy = true;
      reason = 'plain http cannot be framed from a secure context';
    } else if (mode === 'auto') {
      const probe = await probeFraming(url);
      if (probe.ok && probe.framable === false) {
        useProxy = true;
        reason = probe.reason;
      }
    }
    if (mode === 'off' && !isMixedContent(url)) useProxy = false;

    let finalUrl = url;
    if (useProxy) {
      this.proxy.setProfile(this.profileFor(session));
      finalUrl = this.proxy.wrap(url);
      if (reason) this.log('proxying ' + url + ' — ' + reason);
    }

    if (opts && opts.cacheBust) {
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + '__dp_r=' + Date.now().toString(36);
    }

    session.currentUrl = url;
    this.remember(url);
    session.post({ type: 'load', url: finalUrl, real: url, proxied: useProxy, kind: 'web' });
  }

  profileFor(session) {
    const dev = session.device;
    const base = byId(session.state.deviceId);
    const landscape = session.state.orientation === 'landscape';
    const osName = base.os === 'ipados' ? 'ipados'
      : base.os === 'android' ? 'android'
      : base.os === 'macos' ? 'macos'
      : base.os === 'ios' ? 'ios' : 'generic';
    /*
     * A site may be shown something other than a phone's user agent on purpose.
     * Some apps do things on iOS that make no sense inside a preview — send the
     * page to the App Store, refuse to run outside their own shell — and the only
     * way past that is to stop claiming to be a phone, while keeping the touch
     * emulation, the frame and the shim that make the preview worth having.
     */
    const overrides = this.settings.userAgent || {};
    return {
      os: osName,
      ua: overrides[osName] || UA[osName] || UA.generic,
      platform: osName === 'android' ? 'Linux armv8l' : osName === 'macos' ? 'MacIntel' : 'iPhone',
      vendor: osName === 'android' ? 'Google Inc.' : 'Apple Computer, Inc.',
      width: dev.w,
      height: dev.h,
      dpr: dev.dpr,
      orientation: session.state.orientation,
      touch: base.kind === 'phone' || base.kind === 'tablet',
      // A phone is driven by a fingertip, a Mac by a mouse — "auto" means exactly that.
      pointer: pointerFor(this.settings.pointerStyle, base),
      forceViewport: !!this.settings.forceMobileViewport,
      // A tablet keeps its status bar — and its top inset — in landscape too.
      safeTop: landscape && !base.homeButton && base.kind !== 'tablet' ? 0 : base.safeTop,
      safeBottom: landscape ? (base.safeBottom ? 21 : 0) : base.safeBottom,
      safeLeft: landscape ? base.safeSide : 0,
      safeRight: landscape ? base.safeSide : 0,
    };
  }

  // -------------------------------------------------------------- capture

  captureOptions(session, msg) {
    return Object.assign({
      url: msg.url || session.currentUrl,
      device: msg.device || session.state.deviceId,
      orientation: msg.orientation || session.state.orientation,
      custom: session.state.custom,
      finish: this.settings.deviceFinish,
      statusBar: this.settings.statusBarStyle,
      statusBarLayout: this.settings.statusBarLayout,
      browserChrome: this.settings.browserChrome,
      background: this.settings.background,
    }, msg);
  }

  async capture(session, msg) {
    if (!this.capturer.available) {
      session.post({ type: 'captured', error: 'No Chrome or Edge found for capturing.' });
      return;
    }
    try {
      const shot = await this.capturer.shot(this.captureOptions(session, msg));
      let clipboard = false;
      if (msg.toClipboard !== false && shot.file) {
        const res = await copyImage(shot.file);
        clipboard = res.ok;
      }
      session.post({
        type: 'captured', kind: 'screenshot', file: shot.file,
        width: shot.width, height: shot.height, clipboard,
      });
    } catch (err) {
      session.post({ type: 'captured', error: String(err && err.message ? err.message : err) });
    }
  }

  async record(session, msg) {
    if (!this.capturer.available) {
      session.post({ type: 'captured', error: 'No Chrome or Edge found for recording.' });
      return;
    }
    try {
      const clip = await this.capturer.record(this.captureOptions(session, msg));
      let clipboard = false;
      if (clip.file) clipboard = (await copyImage(clip.file)).ok;
      session.post({
        type: 'captured', kind: 'recording', file: clip.file,
        frames: clip.frames, fps: clip.fps,
        seconds: Math.round(clip.frames / (clip.fps || 10)),
        clipboard,
      });
    } catch (err) {
      session.post({ type: 'captured', error: String(err && err.message ? err.message : err) });
    }
  }

  /**
   * Everything about this moment, in one dated folder.
   *
   * Gathered rather than demanded: whatever cannot be had — the page refuses a
   * screenshot, nothing is selected — is simply left out and named in the note,
   * because a partial record beats no record.
   */
  async collect(session, body) {
    const url = session.currentUrl;
    const dev = session.device;
    const payload = {
      // The note wants the device as a person would describe it, not the internal
      // record: name, and the size in the orientation it is actually being viewed.
      device: {
        id: dev.id, name: dev.name, width: dev.w, height: dev.h, dpr: dev.dpr,
        orientation: session.state.orientation,
      },
      note: body.note,
    };

    // Photograph the open window, not a fresh copy of the page: the point of
    // collecting is to record what is on screen right now — this scroll position,
    // these live edits — which a re-rendered document would not have.
    if (body.live !== false && this.chromePort) {
      try {
        const live = await this.windowShot(session, { mode: 'frame', file: false, inline: false });
        payload.screenshot = live.buffer;
      } catch (err) {
        this.log('collect: could not photograph the window — ' + err.message);
      }
    }

    if (!payload.screenshot && this.capturer.available) {
      try {
        const shot = await this.capturer.shot(this.captureOptions(session, { mode: 'frame', name: 'collected' }));
        payload.screenshot = shot.buffer;
      } catch (err) {
        this.log('collect: no screenshot — ' + err.message);
      }
    }

    if (this.capturer.available) {
      if (body.fullPage) {
        try {
          const full = await this.capturer.shot(this.captureOptions(session, { mode: 'full', scale: 1 }));
          payload.fullPage = full.buffer;
        } catch (err) {
          this.log('collect: no full-page shot — ' + err.message);
        }
      }
    }

    try {
      const html = await this.ask({ window: session.id }, { type: 'dp:cmd:html' }, 'dp:html');
      if (html && html.html) payload.html = html.html;
    } catch (err) {
      this.log('collect: no markup — ' + err.message);
    }

    payload.console = session.consoleLog.slice(-400);
    if (session.selection) payload.element = session.selection;

    const result = this.library.collect(url, payload);
    session.post({
      type: 'collected',
      dir: result.dir,
      files: result.files,
    });
    return result;
  }

  async elementForAI(session, msg) {
    const el = msg.element || {};
    let shotFile = '';
    if (this.capturer.available) {
      try {
        const shot = await this.capturer.shot(this.captureOptions(session, {
          mode: 'frame', selector: el.selector, name: 'element',
        }));
        shotFile = shot.file;
      } catch (err) {
        this.log('element screenshot failed: ' + err.message);
      }
    }

    const device = msg.device || {};
    const styles = Object.entries(el.styles || {}).map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n');
    const report = [
      '## Element selected in ' + APP_NAME,
      '',
      '- **Device:** ' + (device.name || '') + ' — ' + device.width + '×' + device.height + ' pt @' + device.dpr + 'x, ' + device.orientation,
      '- **Page:** ' + (el.url || session.currentUrl),
      '- **Element:** `' + el.name + '`',
      '- **Selector:** `' + el.selector + '`',
      '- **Box:** ' + Math.round(el.rect ? el.rect.width : 0) + ' × ' + Math.round(el.rect ? el.rect.height : 0),
      el.ancestors && el.ancestors.length ? '- **Path:** ' + el.ancestors.join(' › ') + ' › ' + el.name : '',
      el.text ? '- **Text:** ' + el.text : '',
      shotFile ? '- **Screenshot with the element ringed:** ' + shotFile : '',
      '',
      styles ? '### Computed styles\n\n```css\n' + el.selector + ' {\n' + styles + '\n}\n```' : '',
      '',
      '### Markup',
      '',
      '```html',
      el.html || '',
      '```',
    ].filter(line => line !== '').join('\n');

    session.post({ type: 'clipboard-text', text: report });
    session.post({
      type: 'captured', kind: 'screenshot', file: shotFile || '(no screenshot)',
      width: Math.round(el.rect ? el.rect.width : 0),
      height: Math.round(el.rect ? el.rect.height : 0),
      clipboard: false,
    });
  }

  /**
   * Ask for a folder with the system's own picker.
   *
   * There is no editor here to borrow a dialog from, so Windows' own is summoned
   * through PowerShell. It needs a single-threaded apartment, which is what -STA
   * is for; without it the dialog never appears and the call simply hangs.
   */
  chooseFolder(initial) {
    return new Promise(resolve => {
      if (process.platform !== 'win32') {
        this.log('folder picking is only wired up for Windows; set captureDirectory in settings.json');
        return resolve('');
      }
      const quoted = "'" + String(initial || '').replace(/'/g, "''") + "'";
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "Where ' + APP_NAME + ' files screenshots, recordings and logs"',
        '$d.SelectedPath = ' + quoted,
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      ].join('; ');

      let out = '';
      const ps = spawn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
      });
      ps.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
      ps.on('error', err => {
        this.log('could not open the folder picker: ' + err.message);
        resolve('');
      });
      ps.on('close', () => resolve(out.trim()));
    });
  }

  /** Reveal a folder in the file manager. */
  openPath(target) {
    if (!target) return;
    try {
      if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, windowsHide: false });
      else if (process.platform === 'darwin') spawn('open', [target], { detached: true });
      else spawn('xdg-open', [target], { detached: true });
    } catch (err) {
      this.log('could not open ' + target + ': ' + err.message);
    }
  }

  openExternal(url) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true });
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true });
      else spawn('xdg-open', [url], { detached: true });
    } catch (err) {
      this.log('could not open externally: ' + err.message);
    }
  }

  // --------------------------------------------------------------- windows

  /**
   * Each window is a Chrome app window: no tabs, no address bar, its own taskbar
   * entry. They share one browser process and one profile, so opening the fifth one
   * costs almost nothing — and every one of them is a CDP target an agent can attach to.
   */
  async openWindow(url, deviceId) {
    const chrome = findChrome(this.settings.chromePath);
    if (!chrome) throw new Error('No Chrome or Edge found. Install one, or set chromePath in ' + CONFIG_FILE);

    const id = this.newSessionId();
    const session = new Session(id, this);
    if (deviceId) session.state.deviceId = byId(deviceId).id;
    if (url) session.pendingUrl = url;
    this.sessions.set(id, session);

    const dev = session.device;
    // Wide enough for the whole toolbar — it holds fifteen controls, and a window
    // sized only to the phone clips half of them.
    const width = Math.min(1600, Math.max(820, Math.round(dev.w * 0.7) + 460));
    const height = Math.min(1150, Math.max(680, Math.round(dev.h * 0.7) + 210));
    const offset = (this.sessions.size - 1) * 34;

    // A leftover port file from a browser that has since exited would be adopted by
    // readChromePort and then refuse every connection; clear it before the first launch.
    if (!this.chromePort && !this.chromeProcs.size) {
      try {
        fs.unlinkSync(path.join(this.profileDir, 'DevToolsActivePort'));
      } catch {
        /* nothing to clear */
      }
    }

    const args = [
      '--app=' + this.origin + '/window?id=' + id,
      '--user-data-dir=' + this.profileDir,
      '--window-size=' + width + ',' + height,
      '--window-position=' + (120 + offset) + ',' + (90 + offset),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-background-networking',
    ];
    if (!this.chromePort) args.push('--remote-debugging-port=0');

    const proc = spawn(chrome, args, { stdio: 'ignore', windowsHide: false, detached: false });
    this.chromeProcs.add(proc);
    proc.on('exit', () => this.chromeProcs.delete(proc));

    this.log('opened window ' + id + ' (' + byId(session.state.deviceId).name + ')');

    if (!this.chromePort) this.readChromePort().catch(() => {});
    return session;
  }

  /**
   * Chrome writes the debugging port it took into the profile directory — but only
   * the process that owns the profile does. A second launch against a profile that
   * is already open just hands its arguments to the running browser and exits,
   * leaving whatever port file was there before. So the file is never trusted until
   * something answers on it.
   */
  async readChromePort() {
    const file = path.join(this.profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;

    for (;;) {
      let port = 0;
      try {
        port = parseInt(fs.readFileSync(file, 'utf8').split('\n')[0], 10);
      } catch {
        port = 0;
      }

      if (port > 0) {
        try {
          await httpJson('http://127.0.0.1:' + port + '/json/version');
          this.chromePort = port;
          this.log('windows are inspectable on 127.0.0.1:' + port);
          this.announce();
          return port;
        } catch {
          // Stale file from a browser that is gone. Remove it so the next launch
          // is forced to open a fresh port rather than reading this one again.
          try {
            fs.unlinkSync(file);
          } catch {
            /* it may already be gone */
          }
        }
      }

      if (Date.now() > deadline) {
        this.log('could not reach the browser debugging port; live control is off');
        return 0;
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  /** Attach to the live page of a window, so captures show what is really on screen. */
  async attach(session) {
    if (session.cdp) return session.cdp;
    if (!this.chromePort) await this.readChromePort();
    if (!this.chromePort) {
      throw new Error(
        'This window is not inspectable. Close every Custom AI View window and start it again.'
      );
    }

    const targets = await httpJson('http://127.0.0.1:' + this.chromePort + '/json/list');
    const wanted = '/window?id=' + session.id;
    const target = (targets || []).find(t => t.type === 'page' && String(t.url).includes(wanted));
    if (!target) throw new Error('Could not find the window for session ' + session.id);

    const cdp = await CdpSession.attach(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /*
     * What the browser itself has to say.
     *
     * The shim can only report what the page prints — it patches console.* and the
     * error events. Everything Chromium says on its own account goes somewhere the
     * page cannot see: a frame refused for framing, a blocked confirm(), a mixed
     * content warning, a CSP violation, a failed request. Those are exactly the
     * messages that explain a screen doing nothing, and the console showed none of
     * them, which is why it read as empty and useless.
     */
    cdp.on('Log.entryAdded', p => {
      const e = (p && p.entry) || {};
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info';
      const where = e.url ? String(e.url).replace(/^https?:\/\//, '').slice(0, 80) : '';
      session.consoleLog.push({
        at: Date.now(),
        level,
        text: '[browser] ' + String(e.text || '').slice(0, 500),
        source: where + (e.lineNumber ? ':' + e.lineNumber : ''),
      });
      if (session.consoleLog.length > 400) session.consoleLog.splice(0, session.consoleLog.length - 400);
      // Straight into the drawer, so it appears next to the page's own output.
      session.post({
        type: 'browser-log',
        level,
        text: '[browser] ' + String(e.text || '').slice(0, 500),
        source: where + (e.lineNumber ? ':' + e.lineNumber : ''),
      });
    });
    await cdp.send('Log.enable').catch(() => { /* older Chrome, or already on */ });

    session.cdp = cdp;
    return cdp;
  }

  /** Clip a photograph of the real window down to one region of the device. */
  async windowShot(session, body) {
    const cdp = await this.attach(session);
    const mode = body.mode || 'frame';
    const scale = Math.min(4, Math.max(1, body.scale || 2));

    const expression =
      'Promise.resolve(window.__dpRegion(' + JSON.stringify(mode) + ', ' +
      JSON.stringify(body.selector || '') + '))';
    const measured = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (measured.exceptionDetails) throw new Error(measured.exceptionDetails.text);

    const clip = measured.result && measured.result.value;
    if (!clip || !clip.width) {
      throw new Error(mode === 'element'
        ? 'Nothing on screen matched ' + body.selector
        : 'Could not measure the device in the window');
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, clip.x),
        y: Math.max(0, clip.y),
        width: Math.ceil(clip.width),
        height: Math.ceil(clip.height),
        scale,
      },
    }, 30000);

    const buffer = Buffer.from(shot.data, 'base64');
    return {
      buffer,
      // Filed by site like every other capture — a photograph of the live window is
      // still a screenshot of that site, and belongs with the rest of its material.
      // Except when the caller is filing it somewhere itself, as "collect" does.
      file: body.file === false
        ? ''
        : this.capturer._file(buffer, session.currentUrl, 'screenshots', body.name || mode, '.png'),
      width: Math.round(clip.width * scale),
      height: Math.round(clip.height * scale),
      mode,
      live: true,
      data: body.inline === false ? undefined : buffer.toString('base64'),
    };
  }

  /** A photograph of the actual window, pixels and all. */
  async liveScreenshot(session) {
    const cdp = await this.attach(session);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
    return Buffer.from(shot.data, 'base64');
  }

  // ----------------------------------------------------------- control api

  async startControlApi() {
    const firstSession = () => this.sessions.values().next().value || null;

    /*
     * The control API answers before the first window exists.
     *
     * Starting the app and immediately steering it is the normal case, not an odd
     * one — it is exactly what happens when an agent launches the exe itself and calls
     * a tool in the same breath. In that gap there is no session, and taking that to
     * mean "no windows, open one" opened a SECOND window: the caller then drove one
     * window while looking at the other, which reads as "the tool shows an empty
     * page". The app closes when its last window goes, so no session with the process
     * alive means one is on its way — wait for it.
     */
    const sessionSoon = async (timeoutMs = 20000) => {
      const existing = firstSession();
      if (existing) return existing;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const found = firstSession();
        if (found) return found;
      }
      return null;
    };

    this.control = new ControlServer({
      log: msg => this.log('control: ' + msg),
      routes: {
        '/state': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) return { open: false, windows: [] };
          const dev = session.device;
          return {
            app: APP_NAME,
            open: true,
            window: session.id,
            windows: [...this.sessions.keys()],
            url: session.currentUrl,
            device: { id: dev.id, name: dev.name, width: dev.w, height: dev.h, dpr: dev.dpr },
            orientation: session.state.orientation,
            proxied: true,
            selection: session.selection
              ? { name: session.selection.name, selector: session.selection.selector, rect: session.selection.rect }
              : null,
            captureAvailable: this.capturer.available,
            liveControl: !!this.chromePort,
          };
        },

        '/windows': async () => ({
          windows: [...this.sessions.values()].map(s => ({
            id: s.id,
            url: s.currentUrl,
            device: byId(s.state.deviceId).name,
            orientation: s.state.orientation,
            title: s.title,
          })),
        }),

        '/devices': async body => {
          const filter = String(body.filter || '').toLowerCase();
          return {
            devices: DEVICES.filter(d => !filter || (d.name + ' ' + d.id).toLowerCase().includes(filter))
              .map(d => ({
                id: d.id, name: d.name, width: d.w, height: d.h, dpr: d.dpr,
                safeTop: d.safeTop, safeBottom: d.safeBottom, cutout: d.cutout,
              })),
          };
        },

        '/open': async body => {
          let session = body.window ? this.sessions.get(body.window) : (body.newWindow ? null : await sessionSoon());
          if (!session || body.newWindow) {
            session = await this.openWindow(body.url, body.device);
            // Do not report success until the window is actually showing something.
            await Promise.race([
              session.ready,
              new Promise(r => setTimeout(r, 25000)),
            ]);
            return {
              window: session.id,
              url: session.currentUrl || body.url || '',
              device: byId(session.state.deviceId).name,
              created: true,
            };
          }
          // Let the window finish coming up before steering it. Its own startup ends
          // by choosing what to show, so anything sent mid-startup is competing with
          // that choice rather than replacing it.
          await Promise.race([session.ready, new Promise(r => setTimeout(r, 25000))]);

          if (body.device) {
            session.state.deviceId = byId(body.device).id;
            session.post({ type: 'command', name: 'set-device', payload: { deviceId: session.state.deviceId } });
          }
          if (body.orientation && body.orientation !== session.state.orientation) {
            session.post({ type: 'command', name: 'rotate' });
          }
          if (body.url) await this.navigate(session, body.url);
          return { window: session.id, url: session.currentUrl, device: byId(session.state.deviceId).name };
        },

        '/new-window': async body => {
          const session = await this.openWindow(body.url, body.device);
          return { window: session.id, device: byId(session.state.deviceId).name };
        },

        '/close-window': async body => {
          const session = this.sessions.get(body.window);
          if (!session) throw new Error('No such window: ' + body.window);
          session.post({ type: 'command', name: 'close-window' });
          return { ok: true };
        },

        '/device': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          if (body.device) {
            session.state.deviceId = byId(body.device).id;
            session.post({ type: 'command', name: 'set-device', payload: { deviceId: session.state.deviceId } });
          }
          if (body.orientation && body.orientation !== session.state.orientation) {
            session.post({ type: 'command', name: 'rotate' });
          }
          const dev = session.device;
          return { device: dev.name, width: dev.w, height: dev.h };
        },

        '/reload': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          session.post({ type: 'command', name: 'reload', payload: { mode: body.mode || 'normal' } });
          return { ok: true };
        },

        '/screenshot': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');

          // "live" photographs the whole window, toolbar and all.
          if (body.mode === 'live') {
            const buffer = await this.liveScreenshot(session);
            const file = this.capturer._file(buffer, session.currentUrl, 'screenshots', 'live', '.png');
            return { file, width: 0, height: 0, mode: 'live', data: body.inline === false ? undefined : buffer.toString('base64') };
          }

          /*
           * Photograph the open window whenever the request is about what is already
           * on screen. Rendering a fresh copy would be a different document — every
           * live edit, every typed character, every scroll position would be lost,
           * and the screenshot would quietly disagree with what the person sees.
           *
           * A request for another URL, another device, or the full scrollable page
           * cannot come from this window, so those still render headlessly.
           */
          const canUseWindow =
            body.live !== false &&
            this.chromePort &&
            !body.url && !body.device && !body.orientation &&
            body.mode !== 'full';

          let liveFailed = '';
          if (canUseWindow) {
            try {
              // The buffer stays on this side of the wire: JSON turns it into an array
              // of several hundred thousand numbers, which is the same picture at
              // roughly three times the size, next to the base64 that is already there.
              const live = await this.windowShot(session, body);
              delete live.buffer;
              return live;
            } catch (err) {
              liveFailed = err.message;
              this.log('live capture failed, rendering a fresh copy: ' + err.message);
            }
          }

          const shot = await this.capturer.shot(this.captureOptions(session, {
            mode: body.mode || 'frame',
            selector: body.selector,
            scale: body.scale,
            url: body.url || session.currentUrl,
            device: body.device,
            orientation: body.orientation,
            name: body.mode || 'frame',
            file: body.file,
          }));
          return {
            file: shot.file, width: shot.width, height: shot.height, mode: shot.mode,
            /*
             * Said out loud, because it is not a detail. This browser has its own
             * throwaway profile: no cookies, no session, the page at the top. A
             * caller told only "Screenshot 804×1748" will describe a login screen as
             * the user's accounting screen and be certain about it.
             */
            live: false,
            liveFailed: liveFailed || undefined,
            data: body.inline === false ? undefined : shot.buffer.toString('base64'),
          };
        },

        '/inspect': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          const selector = body.selector || (session.selection && session.selection.selector);
          if (!selector) throw new Error('No selector given and nothing is selected.');
          const el = await this.capturer.describe(this.captureOptions(session, { selector }));
          const styles = Object.entries(el.styles || {}).map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n');
          return {
            element: el,
            report: [
              'Element: ' + el.name,
              'Selector: ' + el.selector,
              'Box: ' + Math.round(el.rect.width) + ' × ' + Math.round(el.rect.height),
              el.ancestors && el.ancestors.length ? 'Path: ' + el.ancestors.join(' > ') + ' > ' + el.name : '',
              el.text ? 'Text: ' + el.text : '',
              '',
              styles ? 'Computed styles:\n```css\n' + el.selector + ' {\n' + styles + '\n}\n```' : '',
              '',
              'Markup:\n```html\n' + (el.html || '') + '\n```',
            ].filter(Boolean).join('\n'),
          };
        },

        '/record': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          const clip = await this.capturer.record(this.captureOptions(session, {
            durationMs: body.durationMs, fps: body.fps, name: 'recording',
          }));
          return { file: clip.file, frames: clip.frames, fps: clip.fps };
        },

        '/console': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) return { entries: [] };
          const limit = Math.min(400, Math.max(1, body.limit || 50));
          return { entries: session.consoleLog.slice(-limit) };
        },

        // Real input and real edits in the real window, so an agent can drive and
        // change the page the person is looking at.
        '/click': async body => this.ask(body, { type: 'dp:cmd:input', kind: 'click', selector: body.selector }, 'dp:input-done'),
        '/type': async body => this.ask(body, {
          type: 'dp:cmd:input', kind: 'type', selector: body.selector, text: body.text, key: body.key,
        }, 'dp:input-done'),
        '/key': async body => this.ask(body, {
          type: 'dp:cmd:input', kind: 'key', selector: body.selector, key: body.key || 'Enter',
        }, 'dp:input-done'),

        /*
         * Going back, without losing where you were.
         *
         * The alternative was re-opening the URL, which reloads a single-page app from
         * nothing: the route, the scroll position and whatever was typed all go. A
         * wrong tap should cost one step, not the whole screen.
         */
        '/back': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          session.post({ type: 'command', name: 'back' });
          return { ok: true, direction: 'back' };
        },

        '/forward': async body => {
          const session = body.window ? this.sessions.get(body.window) : await sessionSoon();
          if (!session) throw new Error('No window is open.');
          session.post({ type: 'command', name: 'forward' });
          return { ok: true, direction: 'forward' };
        },
        '/scroll': async body => this.ask(body, { type: 'dp:cmd:input', kind: 'scroll', selector: body.selector, dx: body.dx || 0, dy: body.dy || 0 }, 'dp:input-done'),

        '/find': async body => this.ask(body, {
          type: 'dp:cmd:find',
          selector: body.selector,
          text: body.text,
          limit: body.limit,
        }, 'dp:found'),

        /*
         * Wait for the page instead of photographing it until it happens to be right.
         *
         * Polling with screenshots costs an image per attempt and still answers about
         * whatever moment it caught; this answers about the condition, and when the
         * condition never arrives it says so rather than returning the last frame.
         */
        '/wait': async body => {
          const timeout = Math.min(60000, Math.max(500, body.timeoutMs || 10000));
          const started = Date.now();
          const wantGone = body.gone === true;
          const what = body.selector
            ? 'selector ' + body.selector + (wantGone ? ' to go away' : ' to appear')
            : body.text
              ? 'the text "' + body.text + '"' + (wantGone ? ' to go away' : ' to appear')
              : 'loading to finish';

          const settled = async () => {
            if (body.selector || body.text) {
              const found = await this.ask(body, {
                type: 'dp:cmd:find', selector: body.selector, text: body.text, limit: 1,
              }, 'dp:found', 4000).catch(() => null);
              const hit = !!(found && found.matches && found.matches.length &&
                found.matches[0].rect && found.matches[0].rect.width > 0);
              return wantGone ? !hit : hit;
            }
            const ready = await this.ask(body, { type: 'dp:cmd:ready' }, 'dp:ready-state', 4000)
              .catch(() => null);
            return !!(ready && ready.readyState === 'complete');
          };

          while (Date.now() - started < timeout) {
            if (await settled()) return { found: true, waitedMs: Date.now() - started, what };
            await new Promise(r => setTimeout(r, 250));
          }
          return { found: false, waitedMs: Date.now() - started, what };
        },

        '/edit': async body => {
          const spec = {
            selector: body.selector,
            style: body.style,
            text: body.text,
            html: body.html,
            attrs: body.attrs,
            addClass: body.addClass,
            removeClass: body.removeClass,
            remove: body.remove,
          };
          const result = await this.ask(body, Object.assign({ type: 'dp:cmd:edit' }, spec), 'dp:edited');
          // Only a change that actually landed is worth replaying on the next load.
          if (result && result.ok && body.persist !== false) this.proxy.rememberEdit(spec);
          return Object.assign({}, result, { persisted: body.persist !== false, edits: this.proxy.edits.length });
        },

        '/edits': async () => ({ edits: this.proxy.edits }),

        // ---- material: where it goes, and getting it all in one move

        '/library': async () => ({
          root: this.library.root,
          sites: this.library.sites(),
        }),

        '/library/root': async body => {
          if (!body.path) throw new Error('Give a folder path.');
          this.library.setRoot(body.path);
          this.settings.captureDirectory = body.path;
          saveSettings(this.settings);
          return { root: this.library.root };
        },

        '/record/start': async body => {
          const session = body.window ? this.sessions.get(body.window) : this.sessions.values().next().value;
          if (!session) throw new Error('No window is open.');
          return this.capturer.startRecording(this.captureOptions(session, body));
        },

        '/record/stop': async () => {
          const clip = await this.capturer.stopRecording();
          return { file: clip.file, frames: clip.frames, fps: clip.fps, seconds: clip.seconds };
        },

        '/record/status': async () => this.capturer.recordingStatus(),

        '/collect': async body => {
          const session = body.window ? this.sessions.get(body.window) : this.sessions.values().next().value;
          if (!session) throw new Error('No window is open.');
          return this.collect(session, body);
        },

        '/revert': async body => {
          const count = this.proxy.clearEdits();
          const session = body.window ? this.sessions.get(body.window) : this.sessions.values().next().value;
          // The page still holds the old changes, so it has to be re-fetched.
          if (session) session.post({ type: 'command', name: 'reload', payload: { mode: 'normal' } });
          return { cleared: count };
        },

        '/tree': async body => this.ask(body, {
          type: 'dp:cmd:tree',
          path: body.path || [],
        }, 'dp:tree'),
      },
    });

    await this.control.start(0);
  }

  /**
   * Put a question to the previewed page and wait for its answer.
   *
   * Input and edits are addressed by selector rather than by window coordinates:
   * the page is scaled and offset inside the device frame, so a pixel position in
   * the window means nothing to the document inside it.
   *
   * The window's own __dpAsk pairs the reply to the request, and awaitPromise lets
   * the DevTools protocol hand the resolved value straight back.
   */
  async ask(body, message, replyType, timeoutMs) {
    const session = body.window ? this.sessions.get(body.window) : this.sessions.values().next().value;
    if (!session) throw new Error('No window is open.');

    const cdp = await this.attach(session);
    const expression =
      'window.__dpAsk(' + JSON.stringify(message) + ', ' + JSON.stringify(replyType) + ', ' +
      (timeoutMs || 8000) + ')';

    const res = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, (timeoutMs || 8000) + 4000);

    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'the window refused the request');
    const value = res.result ? res.result.value : null;
    if (value && value.error) throw new Error(value.error);
    return value || { ok: false };
  }

  announce() {
    if (this.control) this.control._announce();
  }

  stop() {
    for (const proc of this.chromeProcs) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    if (this.control) this.control.stop();
    this.capturer.dispose();
    this.proxy.stop();
    if (this.server) this.server.close();
  }
}

// ---------------------------------------------------------------- helpers

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error('message too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('devtools http timed out')));
  });
}

module.exports = { AppHost, APP_NAME, CONFIG_FILE, LOG_FILE };
