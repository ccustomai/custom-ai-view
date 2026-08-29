/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Control API.
 *
 * The MCP server runs as its own process, spawned by Claude, so it needs a way to
 * reach the extension. This is that door: a token-protected HTTP server bound to
 * 127.0.0.1, announced through a small file in the user's home directory so the MCP
 * server can find it without any configuration.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDSHAKE_DIR = path.join(os.homedir(), '.custom-ai-view');
const HANDSHAKE_FILE = path.join(HANDSHAKE_DIR, 'control.json');

class ControlServer {
  /**
   * @param {{routes: Record<string, (body: any) => Promise<any>>, log?: (m: string) => void}} opts
   */
  constructor(opts) {
    this.routes = opts.routes;
    this.log = opts.log || (() => {});
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = 0;
  }

  async start(preferredPort) {
    if (this.server) return this.port;

    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch(err => {
          this._json(res, 500, { error: String(err && err.message ? err.message : err) });
        });
      });
      server.on('error', reject);
      server.listen(preferredPort || 0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });

    this._announce();
    this.log(`control api on http://127.0.0.1:${this.port}`);
    return this.port;
  }

  /**
   * Publish where we are listening. Written with mode 0600 because the token in it
   * is what authorises control of the browser.
   */
  _announce() {
    try {
      fs.mkdirSync(HANDSHAKE_DIR, { recursive: true });
      fs.writeFileSync(
        HANDSHAKE_FILE,
        JSON.stringify({ port: this.port, token: this.token, pid: process.pid, started: Date.now() }, null, 2),
        { mode: 0o600 }
      );
    } catch (err) {
      this.log('could not write the control handshake file: ' + err.message);
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
    try {
      const current = JSON.parse(fs.readFileSync(HANDSHAKE_FILE, 'utf8'));
      if (current.pid === process.pid) fs.unlinkSync(HANDSHAKE_FILE);
    } catch {
      /* nothing to clean up */
    }
  }

  async _handle(req, res) {
    if (req.headers.host && !/^127\.0\.0\.1:/.test(req.headers.host)) {
      return this._json(res, 404, { error: 'not found' });
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = bearer || url.searchParams.get('token') || '';
    if (token !== this.token) return this._json(res, 401, { error: 'bad token' });

    const route = this.routes[url.pathname];
    if (!route) return this._json(res, 404, { error: 'no such route: ' + url.pathname });

    const body = await this._body(req);
    const result = await route(body || {});
    return this._json(res, 200, result === undefined ? { ok: true } : result);
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET') return resolve({});
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          reject(new Error('request body too large'));
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
          reject(new Error('body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  _json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  }
}

module.exports = { ControlServer, HANDSHAKE_FILE };
