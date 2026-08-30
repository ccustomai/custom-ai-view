/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Local preview proxy.
 *
 * Two jobs:
 *   1. Make any site embeddable — strips X-Frame-Options and CSP frame-ancestors,
 *      which is what stops a plain <iframe> from showing most of the web.
 *   2. Make the site behave like a phone — sends a real mobile User-Agent and the
 *      matching Sec-CH-UA client hints upstream, then injects a shim into the HTML
 *      that synthesises touch events, drag-scrolls with momentum and hides scrollbars.
 *
 * URL shape:  http://127.0.0.1:<port>/<token>/<base64url(origin)>/<original path>
 *
 * Keeping the original path means relative URLs resolve on their own. Root-absolute
 * URLs (/api/x) arrive without the origin prefix; those are recovered from the
 * Referer header with a 302, and the injected shim rewrites fetch/XHR up front so
 * the redirect is only a fallback.
 *
 * Bound to 127.0.0.1 with a per-session token in the path, so it is not an open relay.
 * No npm dependencies — node:http, node:https, node:zlib only.
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');

const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';

/** Documents above this size are passed through unmodified rather than buffered. */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/*
 * How much of the network log is kept, per window.
 *
 * A preview left open all afternoon makes tens of thousands of requests, and a log
 * that remembers every one of them is a memory leak with a friendly name on it.
 * A few hundred covers the load that went wrong and the minute around it, which is
 * the only part anybody ever reads.
 */
const NETWORK_MAX = 300;

/** Windows whose logs are held at once. The least recently active one is dropped. */
const NETWORK_WINDOWS = 12;

/** Response headers that stop a page from being framed, or that break under proxying. */
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-opener-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-embedder-policy-report-only',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'expect-ct',
  'report-to',
  'reporting-endpoints',
  'nel',
  'clear-site-data',
  'origin-agent-cluster',
  // A no-referrer policy would break the Referer-based origin recovery below.
  'referrer-policy',
  // Service workers cannot work through the proxy and would poison the cache.
  'service-worker-allowed',
  // hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Built-in device profiles for the User-Agent sent upstream. */
const UA = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipados: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  generic: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/** Client hints must agree with the User-Agent or hint-based servers ignore both. */
const HINTS = {
  ios: null, // Safari does not send Sec-CH-UA at all
  ipados: null,
  macos: null,
  android: {
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua-platform-version': '"15.0.0"',
  },
  generic: {
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  },
};

const b64 = {
  enc: s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => {
    try {
      return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return null;
    }
  },
};

const isPrivateHost = host => {
  const h = String(host || '').replace(/:\d+$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
};

class PreviewProxy {
  /**
   * @param {{log?: (msg: string) => void, port?: number, mediaDir: string, stateFile?: string}} opts
   */
  constructor(opts) {
    this.token = crypto.randomBytes(12).toString('hex');
    this.desiredPort = opts.port || 0;
    this.mediaDir = opts.mediaDir;
    this.log = opts.log || (() => {});
    this.server = null;
    this.port = 0;
    /** Device profile the shim and the upstream User-Agent follow. */
    this.profile = { os: 'ios', width: 393, height: 852, dpr: 3, touch: true, forceViewport: false };
    this._assets = null;
    this._starting = null;
    /**
     * Mangled cookie name -> original, for __Host-/__Secure- prefixes.
     *
     * Persisted, because the browser profile outlives this process: a __Host- cookie
     * stored under its mangled name last time is sent back on the next launch, and
     * without the map to undo the mangling it goes upstream under a name the server
     * has never heard of — so the site simply does not know you.
     */
    this._stateFile = opts.stateFile || '';
    this._cookieNames = this._loadCookieNames();
    /** Timestamp until which upstream requests ask for a fresh copy. */
    this._bypassUntil = 0;
    /*
     * Live edits, replayed into every page load.
     *
     * Without this an edit lasts until the next reload, which makes it useless for
     * anything you want to look at twice — and worse, a screenshot taken after a
     * reload would quietly show the unedited page.
     */
    this._edits = [];
    /**
     * What the page asked the network for, per window: windowId -> ring of entries.
     *
     * This is the only place that sees it. The console shows what the page chose to
     * print, and a page that goes blank behind a 401, waits for a fetch that never
     * comes back, or drags in a three-megabyte hero image prints nothing at all.
     */
    this._network = new Map();
    /**
     * Per-window path tokens: windowId -> token, and back again.
     *
     * Every window shares this proxy, this origin and this browser profile, so at the
     * HTTP level nothing tells a request made by the iPhone apart from the same
     * request made by the iPad next to it — and a log that mixes two windows is a log
     * of somebody else's page. The token is the one segment that is already opaque,
     * already per-session, and already inherited by everything a document loads:
     * relative URLs keep it, and the shim rebuilds cross-origin ones out of the token
     * it was handed. Nothing in the injected shim had to change to carry it.
     */
    this._windowTokens = new Map();
    this._tokenWindows = new Map();
  }

  get edits() {
    return this._edits.slice();
  }

  /**
   * Remember an edit so it is re-applied on load. Edits to the same selector merge,
   * so setting a colour twice leaves one instruction rather than two.
   */
  rememberEdit(edit) {
    if (!edit || !edit.selector) return;
    const existing = this._edits.find(e => e.selector === edit.selector);
    if (!existing) {
      this._edits.push(JSON.parse(JSON.stringify(edit)));
      return;
    }
    if (edit.style) existing.style = Object.assign({}, existing.style, edit.style);
    if (edit.attrs) existing.attrs = Object.assign({}, existing.attrs, edit.attrs);
    if (typeof edit.text === 'string') existing.text = edit.text;
    if (typeof edit.html === 'string') existing.html = edit.html;
    if (edit.addClass) existing.addClass = ((existing.addClass || '') + ' ' + edit.addClass).trim();
    if (edit.removeClass) existing.removeClass = ((existing.removeClass || '') + ' ' + edit.removeClass).trim();
    if (edit.remove) existing.remove = true;
  }

  clearEdits() {
    const count = this._edits.length;
    this._edits = [];
    return count;
  }

  get bypassing() {
    return Date.now() < this._bypassUntil;
  }

  /**
   * Ask upstream for a fresh copy for a short window. A hard reload has to cover
   * the document *and* the subresources it pulls in, so it is a time window rather
   * than a single flagged request.
   */
  bypassCache(ms) {
    this._bypassUntil = Date.now() + (ms || 8000);
  }

  // -------------------------------------------------------- network log

  /**
   * The path token that belongs to one window, minted on first use.
   *
   * Not capped, unlike the logs. A token is forty bytes and dropping one belonging to
   * a window that is still open would 400 every request that window makes next —
   * an unbounded handful of those is cheaper than breaking a live page.
   */
  tokenFor(windowId) {
    if (!windowId) return this.token;
    let token = this._windowTokens.get(windowId);
    if (token) return token;
    token = crypto.randomBytes(12).toString('hex');
    this._windowTokens.set(windowId, token);
    this._tokenWindows.set(token, windowId);
    return token;
  }

  /**
   * Draw a line in the log where the window went somewhere else.
   *
   * Clearing would have been easier and worse. The requests that explain a page are
   * made *during* the navigation — the redirect chain it followed, the session call
   * that 401'd on the way in — so a log wiped at the moment of navigating throws away
   * exactly the ones worth having. The boundary says which side each request is on
   * and keeps both.
   */
  markNavigation(windowId, url) {
    this._note(windowId || '', { at: Date.now(), nav: true, url: String(url || '') });
  }

  /**
   * The log for one window, oldest first, filtered.
   *
   * @param {{window?: string, failures?: boolean, url?: string, limit?: number}} opts
   */
  network(opts) {
    const o = opts || {};
    const ring = this._network.get(o.window || '') || [];
    const needle = String(o.url || '').toLowerCase();
    const limit = Math.min(NETWORK_MAX, Math.max(1, o.limit || 50));
    // Boundaries survive every filter. They are what tells a failure on this page
    // apart from the identical one three pages ago.
    const keep = e =>
      e.nav ||
      ((!o.failures || e.failed || e.pending) && (!needle || e.url.toLowerCase().includes(needle)));

    const matched = ring.filter(keep);
    const requests = ring.filter(e => !e.nav);
    return {
      entries: matched.slice(-limit).map(e => Object.assign({}, e)),
      matched: matched.filter(e => !e.nav).length,
      total: requests.length,
      failed: requests.filter(e => e.failed).length,
      pending: requests.filter(e => e.pending).length,
    };
  }

  /** A closed window keeps neither a log nor a token. */
  forgetWindow(windowId) {
    if (!windowId) return;
    this._network.delete(windowId);
    const token = this._windowTokens.get(windowId);
    if (token) {
      this._windowTokens.delete(windowId);
      this._tokenWindows.delete(token);
    }
  }

  _loadCookieNames() {
    if (!this._stateFile) return new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
      return new Map(Object.entries(saved.cookieNames || {}));
    } catch {
      return new Map();
    }
  }

  _saveCookieNames() {
    if (!this._stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(
        this._stateFile,
        JSON.stringify({ cookieNames: Object.fromEntries(this._cookieNames) }, null, 2),
        { mode: 0o600 }
      );
    } catch (err) {
      this.log('could not remember cookie names: ' + err.message);
    }
  }

  /**
   * Drop everything this session accumulated about the site.
   *
   * The stored map goes too. It only decodes cookies the browser is still holding,
   * so keeping it after a purge would leave a decoder for cookies that no longer
   * exist — and dropping it while they DO exist is what used to break the login.
   */
  clearState() {
    this._cookieNames.clear();
    this._saveCookieNames();
    this._bypassUntil = 0;
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  setProfile(profile) {
    this.profile = Object.assign({}, this.profile, profile || {});
  }

  /**
   * Turn a real URL into a proxied one. Naming a window puts everything the page then
   * loads into that window's log, since the token is part of the path every relative
   * URL below it inherits.
   */
  wrap(target, windowId) {
    let u;
    try {
      u = new URL(target);
    } catch {
      return target;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return target;
    if (u.host === `127.0.0.1:${this.port}`) return target; // already proxied
    return `${this.origin}/${this.tokenFor(windowId)}/${b64.enc(u.origin)}${u.pathname}${u.search}${u.hash}`;
  }

  /** Turn a proxied URL back into the real one. */
  unwrap(proxied) {
    let u;
    try {
      u = new URL(proxied);
    } catch {
      return proxied;
    }
    if (u.host !== `127.0.0.1:${this.port}`) return proxied;
    const parsed = this._parsePath(u.pathname + u.search);
    return parsed && parsed.target ? parsed.target : proxied;
  }

  isProxied(url) {
    if (typeof url !== 'string' || !url.startsWith(`${this.origin}/`)) return false;
    return !!this._parsePath(url.slice(this.origin.length));
  }

  async start() {
    if (this.server) return this.port;
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch(err => {
          this.log(`unhandled: ${err && err.stack ? err.stack : err}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`Custom AI View proxy error: ${err && err.message ? err.message : err}`);
        });
      });
      server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
      let retried = false;
      server.on('error', err => {
        /*
         * A fixed port is what keeps the previewed site's storage — and therefore its
         * login — from being wiped on every launch, since the browser keys storage by
         * port. But something else may already hold it, and losing the session is far
         * better than not starting at all.
         */
        if (err && err.code === 'EADDRINUSE' && this.desiredPort && !retried) {
          retried = true;
          this.log(`port ${this.desiredPort} is taken; taking any free port (the site will be signed out)`);
          server.listen(0, '127.0.0.1');
          return;
        }
        this._starting = null;
        reject(err);
      });
      // 'listening' rather than a listen callback, because the retry above calls
      // listen a second time and a callback passed to the first would not fire again.
      server.on('listening', () => {
        this.server = server;
        this.port = server.address().port;
        this.log(`proxy listening on ${this.origin} (token ${this.token.slice(0, 6)}…)`);
        resolve(this.port);
      });
      server.listen(this.desiredPort, '127.0.0.1');
    });
    return this._starting;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
      this._starting = null;
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * Split `/<token>/<key>/<rest>` without decoding anything, so the upstream path
   * keeps its original percent-encoding.
   */
  _parsePath(rawUrl) {
    if (rawUrl.charAt(0) !== '/') return null;
    const slash = rawUrl.indexOf('/', 1);
    if (slash < 0) return null;
    const token = rawUrl.slice(1, slash);
    // Only tokens this session minted open the door. The per-window ones are as long
    // and as random as the original, so there being several weakens nothing.
    if (token !== this.token && !this._tokenWindows.has(token)) return null;
    const window = this._tokenWindows.get(token) || '';
    const after = rawUrl.slice(slash + 1);
    const cut = (() => {
      const s = after.indexOf('/');
      const q = after.indexOf('?');
      if (s < 0 && q < 0) return after.length;
      if (s < 0) return q;
      if (q < 0) return s;
      return Math.min(s, q);
    })();
    const key = after.slice(0, cut);
    let rest = after.slice(cut) || '/';
    if (!rest.startsWith('/')) rest = '/' + rest;
    if (key === '__dp') return { internal: rest, token, window };
    const origin = b64.dec(key);
    if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) return null;
    return { token, window, key, origin, rest, target: origin + rest };
  }

  /**
   * Open a log entry, and hand back the two ways it can close.
   *
   * Written at the START of the request rather than the end, because the request
   * worth seeing most is the one that never finished — and one recorded on
   * completion is, for exactly as long as it matters, not in the log at all. It sits
   * there as pending until it settles or the window goes away.
   */
  _record(windowId, method, url) {
    const entry = {
      at: Date.now(),
      method: String(method || 'GET'),
      url,
      status: 0,
      type: '',
      bytes: 0,
      ms: 0,
      pending: true,
      failed: false,
    };
    this._note(windowId || '', entry);

    let settled = false;
    const close = () => {
      if (settled) return false;
      settled = true;
      entry.pending = false;
      entry.ms = Date.now() - entry.at;
      return true;
    };
    return {
      done: (status, type, bytes) => {
        if (!close()) return;
        entry.status = status || 0;
        entry.type = String(type || '').split(';')[0].trim();
        entry.bytes = bytes || 0;
        entry.failed = !status || status >= 400;
      },
      fail: err => {
        if (!close()) return;
        entry.failed = true;
        entry.error = String((err && err.message) || err || 'the request did not complete');
      },
    };
  }

  _note(windowId, entry) {
    let ring = this._network.get(windowId);
    if (!ring) {
      if (this._network.size >= NETWORK_WINDOWS) {
        // By last activity rather than by age: a window open since breakfast is the
        // one still being looked at, and dropping its log to make room for a window
        // that has already been closed is the wrong way round.
        let stalest = null;
        let quietest = Infinity;
        for (const [id, list] of this._network) {
          const last = list.length ? list[list.length - 1].at : 0;
          if (last < quietest) {
            quietest = last;
            stalest = id;
          }
        }
        if (stalest !== null) this._network.delete(stalest);
      }
      ring = [];
      this._network.set(windowId, ring);
    }
    ring.push(entry);
    if (ring.length > NETWORK_MAX) ring.splice(0, ring.length - NETWORK_MAX);
  }

  /**
   * Files the proxy serves from its own origin.
   *
   * The capture page has to live here rather than on the webview's origin: it embeds
   * the proxied site, and same-origin is what lets it talk to the injected shim.
   */
  _internal(rest, req, res) {
    const file = rest.split('?')[0].replace(/^\//, '');

    const SERVED = {
      'inject.js': ['inject.js', 'application/javascript; charset=utf-8'],
      'shot.html': ['shot.html', 'text/html; charset=utf-8'],
      'shot.js': ['shot.js', 'application/javascript; charset=utf-8'],
      'frame.js': ['frame.js', 'application/javascript; charset=utf-8'],
      'frames.css': ['frames.css', 'text/css; charset=utf-8'],
      'devices.js': [null, 'application/javascript; charset=utf-8'],
    };

    if (file === 'ping') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, port: this.port }));
      return true;
    }

    const entry = SERVED[file];
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return true;
    }

    if (!this._assets) this._assets = new Map();
    if (!this._assets.has(file)) {
      // devices.js is shared with the extension host and lives in src/, not media/.
      const full = entry[0]
        ? path.join(this.mediaDir, entry[0])
        : path.join(this.mediaDir, '..', 'src', 'devices.js');
      try {
        this._assets.set(file, fs.readFileSync(full, 'utf8'));
      } catch (err) {
        this._assets.set(file, `/* custom-ai-view: ${file} missing — ${String(err.message)} */`);
      }
    }

    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    res.end(this._assets.get(file));
    return true;
  }

  async _handle(req, res) {
    // Only this process's own origin may drive the proxy: a stray Host header means
    // something else found the port, and the token alone should not be enough.
    if (req.headers.host && req.headers.host !== `127.0.0.1:${this.port}`) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('not found');
    }

    const parsed = this._parsePath(req.url);

    if (parsed && parsed.internal) return void this._internal(parsed.internal, req, res);

    if (!parsed) {
      // Root-absolute request that lost its prefix. Recover the origin from the
      // referer and bounce; the shim normally prevents this from happening.
      const ref = req.headers.referer;
      if (ref) {
        try {
          const refUrl = new URL(ref);
          const refParsed = this._parsePath(refUrl.pathname + refUrl.search);
          if (refParsed && refParsed.key) {
            // The referring document's own token, so the recovered request stays in
            // the window that made it rather than falling out of every log.
            res.writeHead(302, { location: `/${refParsed.token}/${refParsed.key}${req.url}` });
            return void res.end();
          }
        } catch { /* fall through */ }
      }
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('Custom AI View proxy: request has no target origin.');
    }

    const target = new URL(parsed.target);
    // The panel appends this to force the frame to re-navigate on a hard reload;
    // the site itself should never see it.
    if (target.searchParams.has('__dp_r')) target.searchParams.delete('__dp_r');

    const secure = target.protocol === 'https:';
    const mod = secure ? https : http;
    const headers = this._upstreamHeaders(req, target);
    const record = this._record(parsed.window, req.method, target.href);

    let upstream;
    try {
      upstream = await new Promise((resolve, reject) => {
        const r = mod.request(
          {
            protocol: target.protocol,
            host: target.hostname,
            port: target.port || (secure ? 443 : 80),
            method: req.method,
            path: target.pathname + target.search,
            headers,
            servername: target.hostname,
            // Local dev servers routinely use self-signed certificates. Public hosts
            // keep full validation.
            rejectUnauthorized: !isPrivateHost(target.hostname),
          },
          resolve
        );
        r.on('error', reject);
        r.setTimeout(45000, () => r.destroy(new Error('upstream timed out')));
        if (req.method === 'GET' || req.method === 'HEAD') r.end();
        else req.pipe(r);
      });
    } catch (err) {
      // DNS, refused connection, the 45-second timeout above. The caller's own
      // handler turns this into a 502; the log is where it stops being invisible.
      record.fail(err);
      throw err;
    }

    const outHeaders = this._downstreamHeaders(upstream.headers, parsed, target);
    const type = String(upstream.headers['content-type'] || '');
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
    const isCss = /text\/css/i.test(type);
    const isRedirect = upstream.statusCode >= 300 && upstream.statusCode < 400;
    const length = Number(upstream.headers['content-length'] || 0);

    /*
     * A redirect out of the web entirely.
     *
     * An iOS page will answer with `Location: itms-appss://…` to hand the visitor to
     * the App Store. There is no App Store here, the frame cannot follow it, and the
     * body of such a response is empty — so the device went white and nothing, in any
     * console or log, said why. Saying it is the whole fix; the frame stays usable and
     * the reason is on screen.
     */
    if (isRedirect) {
      const raw = String(upstream.headers.location || '');
      let scheme = '';
      try {
        scheme = new URL(raw, target.href).protocol.replace(':', '');
      } catch {
        scheme = '';
      }
      if (scheme && scheme !== 'http' && scheme !== 'https') {
        const body = Buffer.from(this._externalSchemePage(scheme, raw), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        res.end(body);
        record.done(upstream.statusCode, type, body.length);
        this.log(`page tried to leave for ${scheme}: — ${raw.slice(0, 120)}`);
        return;
      }
    }

    if ((!isHtml && !isCss) || isRedirect || req.method === 'HEAD' || length > MAX_REWRITE_BYTES) {
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
      /*
       * Counted off the wire rather than trusted from content-length, which a chunked
       * response does not send at all — and the responses whose size is the whole
       * story, the image and the unbundled dev-server payload, are exactly the ones
       * most likely to arrive chunked. The listener goes on after pipe(): both run in
       * this tick, and a 'data' event cannot be emitted before the next one.
       */
      let bytes = 0;
      upstream.on('data', c => { bytes += c.length; });
      upstream.on('end', () => record.done(upstream.statusCode, type, bytes));
      upstream.on('close', () => record.done(upstream.statusCode, type, bytes));
      upstream.on('error', err => {
        record.fail(err);
        res.destroy();
      });
      return;
    }

    let raw;
    try {
      raw = await readAll(upstream);
    } catch (err) {
      record.fail(err);
      throw err;
    }
    let body;
    try {
      body = decompress(raw, upstream.headers['content-encoding']);
    } catch (err) {
      this.log(`decompress failed for ${target.href}: ${err.message}`);
      body = raw;
    }

    body = isHtml ? this._injectShim(body, parsed, target) : this._rewriteCss(body);

    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    outHeaders['content-length'] = String(body.length);
    if (isHtml) outHeaders['cache-control'] = 'no-store';
    res.writeHead(upstream.statusCode, outHeaders);
    res.end(body);
    // What came off the wire, not what was served: the shim and the CSS rewrite are
    // this tool's weight, and putting them on the page's bill would be a lie.
    record.done(upstream.statusCode, type, raw.length);
  }

  get insets() {
    const p = this.profile;
    return {
      top: p.safeTop || 0,
      bottom: p.safeBottom || 0,
      left: p.safeLeft || 0,
      right: p.safeRight || 0,
    };
  }

  /** Stylesheets get the interaction-media and safe-area treatment. */
  _rewriteCss(buf) {
    if (buf.length > MAX_REWRITE_BYTES) return buf;
    // latin1 round-trips bytes exactly, and every pattern involved is ASCII.
    return Buffer.from(mobileCss(buf.toString('latin1'), this.insets), 'latin1');
  }

  _upstreamHeaders(req, target) {
    const h = Object.assign({}, req.headers);
    for (const k of Object.keys(h)) {
      if (STRIP_HEADERS.has(k.toLowerCase())) delete h[k];
      if (/^x-forwarded-/i.test(k) || /^sec-ch-ua/i.test(k)) delete h[k];
    }
    h.host = target.host;
    // Documents get rewritten, so ask for them uncompressed and skip the whole
    // decompression bug class; everything else keeps its compression and streams
    // through untouched. `deflate` is never advertised — servers disagree about
    // whether it is zlib- or raw-framed, and guessing wrong corrupts the body.
    const wantsDocument = /text\/html|text\/css/i.test(String(h.accept || ''));
    h['accept-encoding'] = wantsDocument
      ? 'identity'
      : HAS_ZSTD ? 'gzip, br, zstd' : 'gzip, br';

    const os = this.profile.os || 'generic';
    h['user-agent'] = this.profile.ua || UA[os] || UA.generic;
    const hints = HINTS[os];
    if (hints) Object.assign(h, hints);

    // Map proxy-side referer/origin back to the real site so referer checks pass.
    if (h.referer) {
      const real = this.unwrap(h.referer);
      if (real && real !== h.referer) h.referer = real;
      else delete h.referer;
    }
    if (h.origin) {
      if (h.origin === this.origin) h.origin = target.origin;
      else delete h.origin;
    }
    // Always take a full 200 for anything we intend to rewrite.
    delete h['if-none-match'];
    delete h['if-modified-since'];
    delete h.range;

    if (this.bypassing) {
      h['cache-control'] = 'no-cache';
      h.pragma = 'no-cache';
    }

    // Restore the original names of cookies whose __Host-/__Secure- prefix had to
    // be mangled on the way down; the real site checks those exact names.
    if (h.cookie && this._cookieNames.size) {
      h.cookie = String(h.cookie)
        .split(';')
        .map(part => {
          const eq = part.indexOf('=');
          if (eq < 0) return part;
          const name = part.slice(0, eq).trim();
          const original = this._cookieNames.get(name);
          return original ? part.replace(name, original) : part;
        })
        .join(';');
    }
    return h;
  }

  _downstreamHeaders(src, parsed, target) {
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      const key = k.toLowerCase();
      if (STRIP_HEADERS.has(key)) continue;
      if (key === 'permissions-policy') continue; // can block iframe features outright
      if (key === 'location') {
        out.location = this._wrapRelative(v, target, parsed.window);
        continue;
      }
      if (key === 'set-cookie') {
        out['set-cookie'] = (Array.isArray(v) ? v : [v]).map(c => this._sanitizeCookie(c));
        continue;
      }
      if (key === 'link') {
        // preload/prefetch hints pointing at the real origin would escape the proxy
        const list = Array.isArray(v) ? v : [v];
        out.link = list.map(item =>
          item.replace(/<([^>]+)>/g, (m, href) => `<${this._wrapRelative(href, target, parsed.window)}>`)
        );
        continue;
      }
      out[k] = v;
    }
    // During a hard reload nothing may be served from the browser cache either,
    // otherwise the fresh upstream copy never reaches the frame.
    if (this.bypassing) {
      out['cache-control'] = 'no-store, no-cache, must-revalidate';
      out.pragma = 'no-cache';
      delete out.etag;
      delete out['last-modified'];
      delete out.expires;
    }
    return out;
  }

  /**
   * The proxy speaks plain http on 127.0.0.1, so cookies need widening to survive.
   * `__Host-`/`__Secure-` prefixed names are rejected outright by the browser
   * without Secure, so they are renamed here and restored on the way back up —
   * skipping that silently drops most modern session cookies.
   */
  _sanitizeCookie(cookie) {
    const parts = String(cookie).split(';');
    const first = parts.shift() || '';
    const eq = first.indexOf('=');
    let head = first;
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      if (/^__(Host|Secure)-/i.test(name)) {
        const safe = 'dp0' + name.replace(/^__/, '');
        if (this._cookieNames.get(safe) !== name) {
          this._cookieNames.set(safe, name);
          // Written now rather than at shutdown: the app is closed by closing its
          // window, and a map lost there costs the login it was protecting.
          this._saveCookieNames();
        }
        head = first.replace(name, safe);
      }
    }

    const attrs = parts
      .map(p => p.trim())
      .filter(p => {
        const lower = p.toLowerCase();
        return lower !== 'secure' && !lower.startsWith('domain=') && lower !== 'partitioned';
      })
      .map(p => {
        const lower = p.toLowerCase();
        // Everything inside the proxy is same-site, and Strict would keep the
        // cookie off the very first iframe navigation.
        if (lower.startsWith('samesite=')) return 'SameSite=Lax';
        if (lower.startsWith('path=')) return 'Path=/';
        return p;
      });

    return [head.trim()].concat(attrs).join('; ');
  }

  /**
   * The page shown when a site hands the frame to another application.
   *
   * Deliberately plain and small: it has to be readable inside a phone-sized frame,
   * and it is answering the question "why did this go blank", not decorating it.
   */
  _externalSchemePage(scheme, url) {
    const known = {
      'itms-apps': 'the App Store',
      'itms-appss': 'the App Store',
      'itms-services': 'an app install',
      mailto: 'a mail app',
      tel: 'the phone',
      sms: 'the messages app',
      'market': 'Google Play',
      intent: 'an Android app',
    };
    const where = known[scheme] || 'another application';
    const escape = s => String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    return '<!doctype html><meta charset="utf-8">' +
      '<title>Left for ' + escape(where) + '</title>' +
      '<style>' +
      'html,body{margin:0;height:100%;font:15px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;' +
      'background:#f6f7f9;color:#1c1c1e;display:flex;align-items:center;justify-content:center}' +
      '.c{max-width:19em;padding:28px 24px;text-align:center}' +
      'h1{font-size:17px;margin:0 0 10px;font-weight:650}' +
      'p{margin:0 0 12px;color:#3c3c43}' +
      'code{display:block;margin-top:14px;padding:9px 10px;border-radius:8px;background:#e9eaee;' +
      'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:#3c3c43}' +
      '@media (prefers-color-scheme:dark){html,body{background:#1c1c1e;color:#f2f2f7}' +
      'p{color:#aeaeb2}code{background:#2c2c2e;color:#aeaeb2}}' +
      '</style>' +
      '<div class="c"><h1>This page opens ' + escape(where) + '</h1>' +
      '<p>On a real device it would leave the browser here. There is nothing to open it ' +
      'with in a preview, so the page stopped rather than going blank.</p>' +
      '<code>' + escape(url) + '</code></div>';
  }

  _wrapRelative(value, base, windowId) {
    if (!value) return value;
    try {
      const abs = new URL(value, base);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
      return this.wrap(abs.href, windowId);
    } catch {
      return value;
    }
  }

  /**
   * Splice the shim into the HTML.
   *
   * Everything inserted is ASCII, and the document is round-tripped through latin1,
   * so bytes outside ASCII survive untouched whatever the page's charset is. UTF-16
   * documents are detected by BOM and left alone.
   */
  _injectShim(buf, parsed, target) {
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      return buf; // UTF-16, byte splicing is unsafe
    }

    let s = buf.toString('latin1');
    // The window's own token, not the proxy's: every relative URL in the document
    // resolves against this prefix, which is how a subresource ends up in the log of
    // the window that asked for it without the page or the shim knowing anything.
    const prefix = `/${parsed.token}/${parsed.key}`;

    const hasViewport = /<meta[^>]+name\s*=\s*["']?viewport/i.test(s);

    // Tag surgery runs before the origin-string rewrite below, so <base href> is
    // still an untouched URL when it is resolved — rewriting it afterwards would
    // prepend the proxy prefix to a path that already carries one.

    // A <meta> CSP is enforced exactly like the header, and upgrade-insecure-requests
    // in one would rewrite every proxy URL to https and blank the page.
    s = s.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
    // A no-referrer policy would break the Referer-based origin recovery.
    s = s.replace(/<meta[^>]+name\s*=\s*["']?referrer["']?[^>]*>/gi, '');
    s = s.replace(/\sreferrerpolicy\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '');
    // An existing <base href> would silently defeat the whole path-prefix scheme.
    s = s.replace(/<base\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi, (tag, href) => {
      try {
        const abs = new URL(href, target.href);
        if (abs.origin === target.origin) return `<base href="${prefix}${abs.pathname}">`;
      } catch { /* fall through */ }
      return '';
    });
    // Stylesheet bytes are rewritten below, so subresource-integrity hashes on the
    // documents that reference them would no longer match.
    s = s.replace(/\sintegrity\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '');

    // Inline stylesheets need the same interaction-media and safe-area treatment
    // as external ones. Only <style> blocks, never body text that happens to
    // mention a media query.
    s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, open, css, close) =>
      open + mobileCss(css, this.insets) + close
    );

    // Same-origin absolute URLs would leave the proxy (and hit CORS or a framing
    // block). Rewriting the exact origin string covers href/src/action and inline JSON.
    const originEsc = target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(originEsc + '(?=[/"\'`\\s>?#\\\\])', 'g'), prefix);
    s = s.replace(
      new RegExp('(?<=[("\'`\\s=])//' + target.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[/"\'`\\s>?#])', 'g'),
      prefix
    );

    const boot =
      `<script>window.__DEVICE_PREVIEW__=${JSON.stringify({
        token: parsed.token,
        key: parsed.key,
        origin: target.origin,
        proxy: this.origin,
        profile: this.profile,
        hasViewport,
        edits: this._edits,
      })};</script>` +
      `<script src="/${parsed.token}/__dp/inject.js"></script>`;

    const viewportMeta =
      !hasViewport && this.profile.forceViewport
        ? '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        : '';

    const payload = viewportMeta + boot;

    // Run before any of the page's own scripts: immediately after <head>.
    const headOpen = /<head[^>]*>/i.exec(s);
    if (headOpen) {
      const at = headOpen.index + headOpen[0].length;
      s = s.slice(0, at) + payload + s.slice(at);
    } else {
      const htmlOpen = /<html[^>]*>/i.exec(s);
      if (htmlOpen) {
        const at = htmlOpen.index + htmlOpen[0].length;
        s = s.slice(0, at) + '<head>' + payload + '</head>' + s.slice(at);
      } else {
        s = payload + s;
      }
    }

    return Buffer.from(s, 'latin1');
  }

  /** Proxy WebSocket upgrades so Vite/webpack hot reload keeps working. */
  _handleUpgrade(req, socket, head) {
    const parsed = this._parsePath(req.url);
    if (!parsed || parsed.internal) return void socket.destroy();

    const target = new URL(parsed.target);
    const secure = target.protocol === 'https:';
    const mod = secure ? https : http;
    const headers = this._upstreamHeaders(req, target);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';

    /*
     * Logged like any other request, and settled at the handshake rather than at
     * close: a socket that lives for an hour has no meaningful duration, and the only
     * question anyone asks of it is whether it ever came up. "The hot reload stopped
     * working" is that question.
     */
    const record = this._record(parsed.window, 'WS', target.href);

    const r = mod.request({
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
      rejectUnauthorized: !isPrivateHost(target.hostname),
    });

    r.on('upgrade', (upRes, upSocket, upHead) => {
      record.done(upRes.statusCode, 'websocket', 0);
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (const [k, v] of Object.entries(upRes.headers)) {
        for (const item of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${item}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const kill = () => {
        upSocket.destroy();
        socket.destroy();
      };
      upSocket.on('error', kill);
      socket.on('error', kill);
    });
    r.on('error', err => {
      record.fail(err);
      socket.destroy();
    });
    /*
     * A server that answers an upgrade with an ordinary response has refused it, and
     * says so nowhere else — the socket simply never opens and the page never reloads
     * itself again. Drained by hand because that is what node did for us while nothing
     * was listening for 'response'; with a listener attached it stops dumping the body
     * and the upstream socket would be held open for nothing.
     */
    r.on('response', up => {
      up.resume();
      record.fail(new Error('the server refused the upgrade with ' + up.statusCode));
    });
    if (head && head.length) r.write(head);
    r.end();
  }
}

// ------------------------------------------------------------------ CSS filter

/*
 * The two things a page-injected script fundamentally cannot fix.
 *
 * 1. Interaction media features. `@media (hover: hover)` is resolved in the style
 *    engine; JavaScript never participates, so monkey-patching matchMedia fools
 *    scripts but leaves every desktop hover rule applying. Rewriting the query text
 *    to one that can never match is the only way to get the mobile branch.
 * 2. env(safe-area-inset-*). Desktop Chromium always reports 0, so a page that lays
 *    itself out around the notch renders as if there were none. Substituting the
 *    emulated device's insets is what makes the safe area visible at all.
 */
const NEVER_MATCHES = '(min-width:999999px)';
const ALWAYS_MATCHES = '(min-width:0px)';

/**
 * Replace every `env(...)` / `constant(...)` safe-area call, scanning to the
 * matching parenthesis so nested fallbacks like `env(x, calc(1px + 2px))` survive.
 */
function replaceSafeArea(css, insets) {
  let out = '';
  let i = 0;
  const re = /\b(env|constant)\(\s*safe-area-inset-(top|right|bottom|left)\s*/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const start = m.index;
    let depth = 1;
    let j = re.lastIndex;
    while (j < css.length && depth > 0) {
      if (css[j] === '(') depth++;
      else if (css[j] === ')') depth--;
      j++;
    }
    if (depth !== 0) break; // unbalanced, leave the rest alone
    out += css.slice(i, start) + (insets[m[2].toLowerCase()] || 0) + 'px';
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

/**
 * @param {string} css
 * @param {{top:number,right:number,bottom:number,left:number}} insets
 */
function mobileCss(css, insets) {
  // Two phases with placeholders: chaining replaces on interaction features would
  // let an earlier substitution be matched again by a later pattern.
  const parked = [];
  const park = value => '\u0001DP' + (parked.push(value) - 1) + '\u0001';

  let out = css
    .replace(/\(\s*(?:any-)?hover\s*:\s*hover\s*\)/gi, () => park(NEVER_MATCHES))
    .replace(/\(\s*(?:any-)?hover\s*:\s*none\s*\)/gi, () => park(ALWAYS_MATCHES))
    .replace(/\(\s*(?:any-)?pointer\s*:\s*fine\s*\)/gi, () => park(NEVER_MATCHES))
    .replace(/\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/gi, () => park(ALWAYS_MATCHES));

  out = replaceSafeArea(out, insets);
  return out.replace(/\u0001DP(\d+)\u0001/g, (_, n) => parked[Number(n)]);
}

// ------------------------------------------------------------------ utilities

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buf;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
  if (enc === 'deflate') {
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  }
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  if (enc === 'zstd' && HAS_ZSTD) return zlib.zstdDecompressSync(buf);
  return buf;
}

/** Probe whether a URL refuses to be framed, so the UI can proxy only when needed. */
function probeFraming(target, timeout = 6000) {
  return new Promise(resolve => {
    let url;
    try {
      url = new URL(target);
    } catch {
      return resolve({ ok: false, reason: 'bad-url' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return resolve({ ok: true, framable: true, reason: 'non-http' });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          'user-agent': UA.ios,
          accept: 'text/html,application/xhtml+xml',
          'accept-encoding': 'identity',
        },
        rejectUnauthorized: !isPrivateHost(url.hostname),
      },
      res => {
        req.destroy(); // headers are all we need
        const xfo = String(res.headers['x-frame-options'] || '').toLowerCase();
        const csp = String(res.headers['content-security-policy'] || '');
        const ancestors = /frame-ancestors\s+([^;]*)/i.exec(csp);
        let framable = true;
        let reason = '';
        if (xfo.includes('deny') || xfo.includes('sameorigin')) {
          framable = false;
          reason = `X-Frame-Options: ${xfo}`;
        } else if (ancestors) {
          const value = ancestors[1].trim().toLowerCase();
          if (!/\*|http:|https:/.test(value)) {
            framable = false;
            reason = `CSP frame-ancestors ${value}`;
          }
        }
        resolve({ ok: true, framable, reason, status: res.statusCode });
      }
    );
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ ok: false, framable: true, reason: 'timeout' });
    });
    req.on('error', err => resolve({ ok: false, framable: true, reason: err.message }));
    req.end();
  });
}

/** Which of the usual dev-server ports are actually listening right now. */
function scanLocalPorts(ports, timeout = 250) {
  return Promise.all(
    ports.map(
      port =>
        new Promise(resolve => {
          const socket = new net.Socket();
          let done = false;
          const finish = open => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(open ? port : null);
          };
          socket.setTimeout(timeout);
          socket.once('connect', () => finish(true));
          socket.once('timeout', () => finish(false));
          socket.once('error', () => finish(false));
          socket.connect(port, '127.0.0.1');
        })
    )
  )
    .then(list => list.filter(p => p !== null))
    // An open port says nothing about how to talk to it, and assuming http against a
    // dev server that only speaks TLS gives an empty frame and no explanation at all.
    .then(open => Promise.all(open.map(port =>
      probeScheme(port, timeout * 3).then(scheme => ({ port, scheme })))));
}

/*
 * Ports the machine is actually listening on.
 *
 * A fixed list of "usual" ports is a guess, and it was wrong in both directions: it
 * missed a dev server on an unusual port entirely — which reads as "the tool cannot
 * see my server" — while spending time knocking on ports nothing was using. The
 * operating system already knows the answer.
 */
function listeningPorts() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(resolve => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const ports = new Set();
        for (const line of String(stdout).split('\n')) {
          if (!/LISTENING/i.test(line)) continue;
          // "  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    1234"
          const local = line.trim().split(/\s+/)[1] || '';
          const at = local.lastIndexOf(':');
          if (at < 0) continue;
          const host = local.slice(0, at);
          const port = parseInt(local.slice(at + 1), 10);
          if (!(port > 0)) continue;
          // Only what this machine can reach on loopback.
          if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])$/.test(host)) continue;
          ports.add(port);
        }
        resolve([...ports]);
      });
  });
}

/** Windows services that are not web servers and are better left unpoked. */
const NOT_WEB = new Set([135, 137, 138, 139, 445, 623, 5040, 5357, 5985, 5986, 16992, 16993]);

/**
 * Every local port that actually serves web pages, with how to talk to it.
 *
 * Each candidate is asked for a page rather than assumed to be one, so RPC endpoints
 * and file sharing drop out on their own, and what comes back can carry the page's
 * title — "Custom AI" is a better thing to click than "listening".
 *
 * @returns {Promise<Array<{port: number, scheme: string, title: string}>>}
 */
async function discoverDevServers(extra = [], timeout = 500) {
  const listening = await listeningPorts();
  const candidates = [...new Set([...listening, ...extra.map(p => parseInt(p, 10))])]
    .filter(p => p >= 80 && p <= 65535 && !NOT_WEB.has(p))
    // An ephemeral client port is never a dev server, and there are hundreds of them.
    .filter(p => p < 49152 || extra.includes(p));

  const found = await Promise.all(candidates.map(async port => {
    const scheme = await probeScheme(port, timeout);
    const page = await probeWebPage(port, scheme, timeout * 4);
    if (!page) return null;
    const origin = scheme + '://localhost:' + port;
    let icon = page.icon || '/favicon.ico';
    try {
      icon = new URL(icon, origin).href;
    } catch {
      icon = origin + '/favicon.ico';
    }
    return { port, scheme, title: page.title, icon, url: origin };
  }));
  return found.filter(Boolean).sort((a, b) => a.port - b.port);
}

/** Ask a port for a page. Returns null unless it answers like a web server. */
function probeWebPage(port, scheme, timeout) {
  return new Promise(resolve => {
    const lib = scheme === 'https' ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port, path: '/', method: 'GET', timeout,
      rejectUnauthorized: false,
      headers: { accept: 'text/html', 'user-agent': 'Custom AI View (looking for dev servers)' },
    }, res => {
      const type = String(res.headers['content-type'] || '');
      if (!/text\/html|application\/xhtml/i.test(type)) {
        res.destroy();
        return resolve(null);
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        chunks.push(c);
        size += c.length;
        if (size > 65536) res.destroy();
      });
      const done = () => {
        const head = Buffer.concat(chunks).toString('utf8');
        const match = head.match(/<title[^>]*>([^<]{1,80})/i);
        /*
         * The site's own icon, so the list looks like the things it names rather than
         * a column of identical dots. Only the href is taken here; the picture itself
         * is fetched by the page that shows it, which is already allowed to.
         */
        let icon = '';
        const link = head.match(
          /<link[^>]+rel=["']?[^"'>]*\bicon\b[^"'>]*["']?[^>]*>/gi
        );
        if (link) {
          for (const tag of link) {
            const href = tag.match(/href=["']([^"']+)["']/i);
            if (href && href[1]) { icon = href[1]; break; }
          }
        }
        resolve({
          title: match ? match[1].trim().replace(/\s+/g, ' ') : '',
          icon,
        });
      };
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Does whatever is listening on this port speak TLS?
 *
 * Settled by starting a handshake rather than by convention: 5173 is plain http on
 * one machine and https on the next, and only the socket knows which.
 *
 * @returns {Promise<'https'|'http'>}
 */
function probeScheme(port, timeout = 750) {
  return new Promise(resolve => {
    let done = false;
    const finish = scheme => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(scheme);
    };
    const socket = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' },
      () => finish('https')
    );
    socket.setTimeout(timeout);
    socket.once('timeout', () => finish('http'));
    socket.once('error', () => finish('http'));
  });
}

module.exports = {
  PreviewProxy, probeFraming, scanLocalPorts, probeScheme, discoverDevServers, listeningPorts, UA,
};
