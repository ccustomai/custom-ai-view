/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Minimal Chrome DevTools Protocol client.
 *
 * Screenshots and screen recording need a real renderer, and the one thing a webview
 * cannot do is photograph its own cross-origin frame. So captures are taken by a
 * headless Chrome that loads the very same device frame — same CSS, same proxy, same
 * viewport — and photographs it properly.
 *
 * CDP speaks WebSocket, so a small RFC 6455 client is implemented here rather than
 * pulling in a dependency. Frames arrive split across TCP reads and screenshot
 * payloads run to megabytes, so the reader buffers and handles the 64-bit length form.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/*
 * Temporary directories, and getting rid of them.
 *
 * Every capture runs a headless Chrome in a throwaway profile, and every
 * recording collects its frames in a folder of its own. Both were removed on
 * the way out — once, half a second after the browser was killed. On Windows
 * that is too early: Chrome still holds handles, rmSync throws, and the error
 * was swallowed as harmless. It was not harmless. Thirty-five abandoned
 * profiles, the oldest four days old, came to half a gigabyte.
 *
 * So two changes. The removal now waits for the handles to go, over several
 * attempts. And because no amount of patience helps a process that was killed
 * outright, anything left behind by an earlier run is swept at startup.
 */
const TEMP_PREFIXES = [
  'custom-ai-view-shot-',
  'custom-ai-view-rec-',
  // What the same directories were called before the rename. Machines that ran
  // an older build still have them, and nothing else will ever clear them.
  'device-preview-shot-',
  'device-preview-rec-',
];

/** Delete a directory once whatever was holding it lets go. */
function removeWhenReleased(dir, attempt) {
  const n = attempt || 0;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    /* still held */
  }
  // 0.4s, 1s, 2s, 4s, 8s. Chrome has always let go well inside that; if it has
  // not, the sweep below will collect the directory on the next run.
  if (n < 5) setTimeout(() => removeWhenReleased(dir, n + 1), 400 * Math.pow(2, n));
}

/**
 * Clear out what earlier runs left behind.
 *
 * Only directories older than half an hour, so a capture running right now in
 * another window is never pulled out from under it. Best effort throughout: a
 * machine that will not let us tidy up is not a machine that should fail to
 * take a screenshot.
 */
let swept = false;
function sweepAbandonedTemp(log) {
  if (swept) return;
  swept = true;
  const cutoff = Date.now() - 30 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!TEMP_PREFIXES.some(p => name.startsWith(p))) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        const st = fs.statSync(dir);
        if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
        bytes += dirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* in use, or gone between the listing and the look */
      }
    }
  } catch {
    /* no temp directory to read is not a reason to fail */
  }
  if (removed && log) {
    log('swept ' + removed + ' abandoned capture folder' + (removed === 1 ? '' : 's')
      + ' (' + (bytes / 1048576).toFixed(0) + ' MB)');
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(here, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* gone between the listing and the look */ } }
    }
  }
  return total;
}

// ------------------------------------------------------------- WebSocket

class WebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.closed = false;

    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._drain();
    });
    socket.on('close', () => {
      this.closed = true;
      this.onClose();
    });
    socket.on('error', () => {
      this.closed = true;
      this.onClose();
    });
  }

  static connect(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          Host: target.host,
          // No Origin header: Chrome refuses DevTools connections that carry one,
          // which is what stops a web page from driving the browser.
        },
      });

      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('websocket handshake timed out'));
      }, timeout);

      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          return reject(new Error('bad websocket accept header'));
        }
        socket.setNoDelay(true);
        const client = new WebSocketClient(socket);
        if (head && head.length) {
          client.buffer = Buffer.concat([client.buffer, head]);
          client._drain();
        }
        resolve(client);
      });

      req.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }

  send(text) {
    if (this.closed) throw new Error('websocket is closed');
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0xfe;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  _drain() {
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;

      const { opcode, fin, payload } = frame;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        // ping -> pong, unmasked payload echoed back
        this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | payload.length]), crypto.randomBytes(4), payload]));
        continue;
      }
      if (opcode === 0xa) continue; // pong

      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }

      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this.onMessage(full.toString('utf8'));
      }
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      if (high > 0x001fffff) throw new Error('websocket frame too large');
      len = high * 0x100000000 + low;
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.slice(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

    this.buffer = buf.slice(offset + len);
    return { fin, opcode, payload };
  }
}

// ------------------------------------------------------------------ CDP

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onMessage = text => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      } else if (msg.method) {
        // The session an event came from, passed on to the handler. A
        // cross-origin iframe is a target of its own, and without knowing which
        // one spoke there is no way to answer it.
        const list = this.handlers.get(msg.method);
        if (list) list.forEach(fn => fn(msg.params, msg.sessionId));
      }
    };
    ws.onClose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
  }

  static async attach(webSocketDebuggerUrl) {
    const ws = await WebSocketClient.connect(webSocketDebuggerUrl);
    return new CdpSession(ws);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  off(method) {
    this.handlers.delete(method);
  }

  /**
   * @param {string} [sessionId] Send into an attached target rather than this one.
   *   Cross-origin iframes run in their own process and answer only on their own
   *   session; a command without this reaches the top-level page and nothing else.
   */
  send(method, params, timeout = 30000, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, timeout);
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const frame = { id, method, params: params || {} };
      if (sessionId) frame.sessionId = sessionId;
      this.ws.send(JSON.stringify(frame));
    });
  }

  close() {
    this.ws.close();
  }
}

// ------------------------------------------------------------- browser

const CHROME_CANDIDATES = [
  process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && !candidate.includes('undefined') && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** A headless Chrome kept alive between captures, since launch dominates the cost. */
class HeadlessBrowser {
  constructor(opts = {}) {
    this.chromePath = findChrome(opts.chromePath);
    this.log = opts.log || (() => {});
    this.proc = null;
    this.port = 0;
    this.profileDir = null;
    this._starting = null;
  }

  get available() {
    return !!this.chromePath;
  }

  async start() {
    if (this.proc && this.port) return this.port;
    if (this._starting) return this._starting;
    if (!this.chromePath) throw new Error('No Chrome or Edge found. Set customAIView.chromePath.');

    this._starting = (async () => {
      // Before making another one, collect the ones earlier runs did not.
      sweepAbandonedTemp(msg => this.log(msg));
      this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-ai-view-shot-'));
      const args = [
        '--headless=new',
        '--remote-debugging-port=0',
        '--user-data-dir=' + this.profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        'about:blank',
      ];
      this.proc = spawn(this.chromePath, args, { stdio: 'ignore', windowsHide: true });
      this.proc.on('exit', () => {
        this.proc = null;
        this.port = 0;
        this._starting = null;
      });

      // Chrome writes the port it actually took into the profile directory.
      const portFile = path.join(this.profileDir, 'DevToolsActivePort');
      const deadline = Date.now() + 20000;
      for (;;) {
        // The file can exist while Chrome is still writing it, and Windows locks it
        // meanwhile — so a failed read here means "not yet", not "broken".
        try {
          const text = fs.readFileSync(portFile, 'utf8').split('\n');
          const port = parseInt(text[0], 10);
          if (port > 0) {
            this.port = port;
            break;
          }
        } catch {
          /* not written yet, or momentarily locked */
        }
        if (Date.now() > deadline) throw new Error('headless Chrome did not start in time');
        await new Promise(r => setTimeout(r, 120));
      }

      this.log('headless browser on 127.0.0.1:' + this.port);
      return this.port;
    })();

    try {
      return await this._starting;
    } catch (err) {
      this._starting = null;
      this.stop();
      throw err;
    }
  }

  /** Open a fresh tab and attach a CDP session to it. */
  async newPage() {
    await this.start();
    const target = await this._json('/json/new?about:blank', 'PUT');
    const session = await CdpSession.attach(target.webSocketDebuggerUrl);
    session.targetId = target.id;
    session.browserPort = this.port;
    return session;
  }

  async closePage(session) {
    try {
      session.close();
    } catch {
      /* ignore */
    }
    try {
      await this._json('/json/close/' + session.targetId);
    } catch {
      /* ignore */
    }
  }

  _json(route, method) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.port, path: route, method: method || 'GET' },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('devtools http timed out')));
      req.end();
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.port = 0;
    this._starting = null;
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = null;
      removeWhenReleased(dir);
    }
  }
}

module.exports = {
  WebSocketClient, CdpSession, HeadlessBrowser, findChrome,
  sweepAbandonedTemp, removeWhenReleased,
};
