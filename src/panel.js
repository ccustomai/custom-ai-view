/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { DEVICES, byId, pointerFor } = require('./devices.js');
const { probeFraming, discoverDevServers, UA } = require('./proxy.js');
const { Capturer } = require('./capture.js');
const { copyImage } = require('./clipboard.js');
const { detect: detectDisplay } = require('./display.js');
const { Library } = require('./library.js');

const STATE_KEY = 'customAIView.state.v1';
const HISTORY_KEY = 'customAIView.history.v1';

const COMMON_PORTS = [
  3000, 3001, 3002, 4000, 4200, 4321, 5000, 5001, 5173, 5174, 5175,
  8000, 8080, 8081, 8100, 8888, 9000, 1313, 1234, 7357,
];

const nonce = () => crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::]']);

/** Plain http outside loopback cannot be framed from a secure webview. */
function isMixedContent(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    return !LOOPBACK.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The panel owns one webview, its state and the URL resolution pipeline. */
class DevicePanel {
  static current = null;

  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./proxy.js').PreviewProxy} proxy
   * @param {vscode.OutputChannel} output
   */
  static createOrShow(context, proxy, output, url) {
    const cfg = vscode.workspace.getConfiguration('customAIView');
    const column =
      cfg.get('openInColumn') === 'active'
        ? vscode.window.activeTextEditor
          ? vscode.window.activeTextEditor.viewColumn
          : vscode.ViewColumn.One
        : vscode.ViewColumn.Beside;

    if (DevicePanel.current) {
      DevicePanel.current.panel.reveal(column, false);
      if (url) DevicePanel.current.navigate(url);
      return DevicePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'customAIView',
      'Custom AI View',
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        enableForms: true,
        enableCommandUris: false,
        retainContextWhenHidden: cfg.get('retainContext') !== false,
        enableFindWidget: false,
        localResourceRoots: [
          context.extensionUri,
          ...(vscode.workspace.workspaceFolders || []).map(f => f.uri),
        ],
      }
    );

    DevicePanel.current = new DevicePanel(panel, context, proxy, output);
    if (url) DevicePanel.current.pendingUrl = url;
    return DevicePanel.current;
  }

  constructor(panel, context, proxy, output) {
    this.panel = panel;
    this.context = context;
    this.proxy = proxy;
    this.output = output;
    this.disposables = [];
    this.pendingUrl = null;
    this.currentUrl = '';
    this.ready = false;
    this.lastCapture = null;
    this.displayMetrics = null;
    this.selection = null;
    this.selectionDevice = null;
    /** Ring buffer of page console output, for the control API. */
    this.consoleLog = [];
    /** In-flight questions to the previewed page, by request id. */
    this.rpc = new Map();
    this.rpcSeq = 0;
    // Material is filed by site under one root the person can point anywhere; the
    // scratch folder inside the capturer is only the fallback when that fails.
    this.library = new Library({
      root: vscode.workspace.getConfiguration('customAIView').get('captureDirectory') || '',
      log: msg => output.appendLine('library: ' + msg),
    });
    this.capturer = new Capturer({
      proxy,
      log: msg => output.appendLine(msg),
      chromePath: vscode.workspace.getConfiguration('customAIView').get('chromePath') || '',
      library: this.library,
    });
    this.disposables.push({ dispose: () => this.capturer.dispose() });

    this.state = Object.assign(
      {
        deviceId: null,
        orientation: 'portrait',
        zoom: 'fit',
        mode: 'single',
        custom: { w: 400, h: 800, dpr: 2 },
        touch: null,
      },
      context.workspaceState.get(STATE_KEY) || {}
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg'),
    };

    panel.webview.html = this.render();

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
    panel.onDidChangeViewState(
      e => vscode.commands.executeCommand('setContext', 'customAIView.focused', e.webviewPanel.active),
      null,
      this.disposables
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('customAIView')) return;
        if (e.affectsConfiguration('customAIView.captureDirectory')) {
          this.library.setRoot(vscode.workspace.getConfiguration('customAIView').get('captureDirectory') || '');
          this.post(Object.assign({ type: 'recording-state' }, this.capturer.recordingStatus(),
            { libraryRoot: this.library.root }));
        }
        this.post({ type: 'config', config: this.config() });
      })
    );
  }

  dispose() {
    vscode.commands.executeCommand('setContext', 'customAIView.focused', false);
    if (DevicePanel.current === this) DevicePanel.current = null;
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.panel.dispose();
  }

  post(msg) {
    return this.panel.webview.postMessage(msg);
  }

  config() {
    const c = vscode.workspace.getConfiguration('customAIView');
    return {
      defaultDevice: c.get('defaultDevice'),
      startUrl: c.get('startUrl'),
      clock: c.get('clock'),
      customClock: c.get('customClock'),
      statusBarStyle: c.get('statusBarStyle'),
      statusBarLayout: c.get('statusBarLayout'),
      browserChrome: c.get('browserChrome'),
      deviceFinish: c.get('deviceFinish'),
      background: c.get('background'),
      shadow: c.get('shadow'),
      showLabel: c.get('showLabel'),
      zoom: c.get('zoom'),
      touchEmulation: c.get('touchEmulation'),
      gridDevices: c.get('gridDevices'),
      forceMobileViewport: c.get('forceMobileViewport'),
      // Millimetres per physical pixel, so the panel can draw a device at its true
      // size. The browser has no way to work this out on its own.
      display: this.displayMetrics,
      calibration: c.get('screenCalibration') || 1,
      pointerStyle: c.get('pointerStyle'),
      libraryRoot: this.library.root,
    };
  }

  async refreshDisplay() {
    try {
      const info = await detectDisplay();
      this.displayMetrics = info.primary;
      if (this.ready) this.post({ type: 'config', config: this.config() });
    } catch (err) {
      this.output.appendLine('could not read the display size: ' + err.message);
    }
  }

  saveState(partial) {
    this.state = Object.assign({}, this.state, partial || {});
    this.context.workspaceState.update(STATE_KEY, this.state);
  }

  history() {
    return this.context.globalState.get(HISTORY_KEY) || [];
  }

  pushHistory(url) {
    if (!url || url.startsWith('vscode-') || url.startsWith('data:')) return;
    const list = this.history().filter(u => u !== url);
    list.unshift(url);
    this.context.globalState.update(HISTORY_KEY, list.slice(0, 40));
  }

  // ----------------------------------------------------------- webview HTML

  render() {
    const webview = this.panel.webview;
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    // devices.js is shared with the extension host, so it lives in src/ and is
    // loaded from there rather than duplicated into media/.
    const srcAsset = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src', name));
    const n = nonce();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${n}'`,
      `connect-src ${webview.cspSource} https: http:`,
      // the whole point of the extension: an arbitrary page inside the frame
      `frame-src ${webview.cspSource} https: http: data: blob:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('ui.css')}">
<link rel="stylesheet" href="${asset('frames.css')}">
<title>Custom AI View</title>
</head>
<body class="dp-body">
  <div id="app" class="dp-app">
    <header class="dp-toolbar" id="toolbar"></header>
    <main class="dp-stage" id="stage" tabindex="0">
      <div class="dp-stage-inner" id="stageInner"></div>
    </main>
    <section class="dp-carousel" id="carousel" hidden></section>
    <section class="dp-devtools" id="devtools" hidden></section>
    <footer class="dp-selection" id="selection" hidden></footer>
    <div class="dp-popover" id="popover" hidden></div>
    <div class="dp-toast" id="toast" hidden></div>
  </div>
  <script nonce="${n}">window.__DP_ASSETS__ = ${JSON.stringify({
      start: asset('start.html').toString(),
    })};</script>
  <script nonce="${n}" src="${srcAsset('devices.js')}"></script>
  <script nonce="${n}" src="${asset('frame.js')}"></script>
  <script nonce="${n}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }

  // ------------------------------------------------------------- messaging

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        this.post({
          type: 'init',
          devices: DEVICES,
          state: this.state,
          config: this.config(),
          history: this.history(),
        });
        const initial =
          this.pendingUrl || this.config().startUrl || this.state.lastUrl || '';
        this.pendingUrl = null;
        if (initial) this.navigate(initial);
        else this.post({ type: 'start-page' });
        this.refreshPorts();
        this.refreshDisplay();
        break;
      }
      case 'navigate':
        await this.navigate(msg.url, msg.force);
        break;
      case 'state':
        this.saveState(msg.state);
        // Screen calibration describes the monitor, not this panel, so it belongs in
        // settings where every window and every workspace picks it up.
        if (msg.state && typeof msg.state.calibration === 'number' && msg.state.calibration > 0) {
          const cfg = vscode.workspace.getConfiguration('customAIView');
          if (Math.abs((cfg.get('screenCalibration') || 1) - msg.state.calibration) > 0.0001) {
            cfg.update('screenCalibration', msg.state.calibration, vscode.ConfigurationTarget.Global);
          }
        }
        break;
      case 'navigated':
        this.currentUrl = msg.url;
        this.saveState({ lastUrl: msg.url });
        this.pushHistory(msg.url);
        if (msg.title) this.panel.title = `${msg.title} — Custom AI View`;
        break;
      case 'device-changed':
        this.saveState({ deviceId: msg.deviceId, orientation: msg.orientation });
        this.updateTitle(msg.deviceName);
        break;
      case 'open-external':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage('$(check) URL copied', 2000);
        break;
      case 'pick-device':
        vscode.commands.executeCommand('customAIView.pickDevice');
        break;
      case 'scan-ports':
        this.refreshPorts();
        break;
      case 'hard-reload':
        // Flip the proxy into revalidate mode, then hand the same URL back so the
        // frame re-fetches it — the document and its subresources both bypass.
        if (this.proxy.port) this.proxy.bypassCache(8000);
        await this.navigate(msg.url || this.currentUrl, undefined, { cacheBust: true });
        break;
      case 'revert-edits': {
        const cleared = this.proxy.clearEdits();
        this.runCommand('reload', { mode: 'normal' });
        this.output.appendLine('reverted ' + cleared + ' live edit(s)');
        break;
      }
      case 'purge':
        this.proxy.clearState();
        if (this.proxy.port) this.proxy.bypassCache(10000);
        this.output.appendLine('cleared proxy state and started a revalidate window');
        break;
      case 'capture':
        await this.capture(msg);
        break;
      case 'record':
        await this.record(msg);
        break;
      case 'record-start':
        try {
          await this.capturer.startRecording(this.captureOptions(msg));
          this.post({ type: 'recording-state', recording: true, seconds: 0, libraryRoot: this.library.root });
        } catch (err) {
          this.output.appendLine('recording could not start: ' + err.message);
          this.post({ type: 'recording-state', recording: false });
          this.post({ type: 'captured', error: String(err.message) });
        }
        break;
      case 'record-stop':
        try {
          const clip = await this.capturer.stopRecording();
          this.post({ type: 'recording-state', recording: false });
          this.post({
            type: 'captured',
            kind: 'recording',
            file: clip.file,
            frames: clip.frames,
            fps: clip.fps,
            seconds: clip.seconds,
            clipboard: clip.file ? (await copyImage(clip.file)).ok : false,
          });
        } catch (err) {
          this.output.appendLine('recording failed: ' + err.message);
          this.post({ type: 'recording-state', recording: false });
          this.post({ type: 'captured', error: String(err.message) });
        }
        break;
      case 'collect':
        try {
          await this.collect(msg);
        } catch (err) {
          this.output.appendLine('collect failed: ' + (err && err.stack ? err.stack : err));
          this.post({ type: 'captured', error: String(err && err.message ? err.message : err) });
        }
        break;
      case 'open-site-folder': {
        const dir = this.library.siteDir(this.currentUrl);
        try {
          require('fs').mkdirSync(dir, { recursive: true });
        } catch (err) {
          this.output.appendLine('could not create ' + dir + ': ' + err.message);
        }
        this.openPath(dir);
        break;
      }
      case 'open-path':
        this.openPath(msg.path);
        break;
      case 'choose-library-root': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Save here',
          title: 'Where Custom AI View files screenshots, recordings and logs',
          defaultUri: vscode.Uri.file(this.library.root),
        });
        if (!picked || !picked.length) break;
        const root = picked[0].fsPath;
        // Global, because it describes where this person keeps their material —
        // not something that should change with the workspace.
        await vscode.workspace
          .getConfiguration('customAIView')
          .update('captureDirectory', root, vscode.ConfigurationTarget.Global);
        this.library.setRoot(root);
        this.post({ type: 'library-root', root: this.library.root });
        break;
      }
      case 'element-for-ai':
        await this.elementForAI(msg);
        break;
      case 'rpc-result': {
        const pending = this.rpc.get(msg.id);
        if (pending) {
          this.rpc.delete(msg.id);
          pending(msg.result);
        }
        break;
      }
      case 'selection':
        this.selection = msg.element;
        this.selectionDevice = msg.device;
        break;
      case 'console':
        for (const entry of msg.entries || []) {
          this.consoleLog.push(Object.assign({ at: Date.now() }, entry));
        }
        if (this.consoleLog.length > 400) this.consoleLog.splice(0, this.consoleLog.length - 400);
        break;
      case 'error':
        this.output.appendLine(`[webview] ${msg.message}`);
        break;
      case 'log':
        this.output.appendLine(`[webview] ${msg.message}`);
        break;
      default:
        break;
    }
  }

  /**
   * Put a question to the previewed page through the panel.
   *
   * The extension host cannot reach into a webview's nested frame, so the panel
   * relays: host asks the panel, panel asks the page, the answer comes back the
   * same way. A request id keeps concurrent questions apart.
   */
  ask(message, replyType, timeoutMs) {
    const id = ++this.rpcSeq;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.rpc.delete(id);
        resolve({ error: 'The preview did not answer in time.' });
      }, (timeoutMs || 8000) + 2000);

      this.rpc.set(id, result => {
        clearTimeout(timer);
        resolve(result);
      });

      this.post({ type: 'rpc', id, message, replyType, timeout: timeoutMs || 8000 });
    });
  }

  // -------------------------------------------------------------- capture

  async capture(msg) {
    if (!this.capturer || !this.capturer.available) {
      this.post({
        type: 'captured',
        error: 'No Chrome or Edge found for capturing. Set customAIView.chromePath.',
      });
      return;
    }
    try {
      const shot = await this.capturer.shot(Object.assign({}, msg, { url: msg.url || this.currentUrl }));
      let clipboard = false;
      if (msg.toClipboard !== false && shot.file) {
        const res = await copyImage(shot.file);
        clipboard = res.ok;
        if (!res.ok) this.output.appendLine('clipboard copy failed: ' + res.error);
      }
      this.lastCapture = shot;
      this.post({
        type: 'captured',
        kind: 'screenshot',
        file: shot.file,
        width: shot.width,
        height: shot.height,
        clipboard,
      });
    } catch (err) {
      this.output.appendLine('capture failed: ' + (err && err.stack ? err.stack : err));
      this.post({ type: 'captured', error: String(err && err.message ? err.message : err) });
    }
  }

  async record(msg) {
    if (!this.capturer || !this.capturer.available) {
      this.post({ type: 'captured', error: 'No Chrome or Edge found for recording.' });
      return;
    }
    try {
      const clip = await this.capturer.record(Object.assign({}, msg, { url: msg.url || this.currentUrl }));
      let clipboard = false;
      if (clip.file) {
        const res = await copyImage(clip.file);
        clipboard = res.ok;
      }
      this.post({
        type: 'captured',
        kind: 'recording',
        file: clip.file,
        frames: clip.frames,
        fps: clip.fps,
        seconds: Math.round(clip.frames / (clip.fps || 10)),
        clipboard,
      });
    } catch (err) {
      this.output.appendLine('recording failed: ' + (err && err.stack ? err.stack : err));
      this.post({ type: 'captured', error: String(err && err.message ? err.message : err) });
    }
  }

  /**
   * Fill in what the webview did not say.
   *
   * The camera menu sends only what it decided — a frame rate, a mode — and leaves
   * the page and the device to the host, which is the side that actually knows them.
   */
  captureOptions(msg) {
    const dev = byId(this.state.deviceId || this.config().defaultDevice);
    const opts = {
      url: this.currentUrl,
      device: dev.id,
      orientation: this.state.orientation,
    };
    for (const [key, value] of Object.entries(msg || {})) {
      if (key !== 'type' && value !== undefined && value !== null) opts[key] = value;
    }
    return opts;
  }

  /** The device as the note should describe it, in the orientation it is being viewed. */
  deviceInfo() {
    const dev = byId(this.state.deviceId || this.config().defaultDevice);
    const landscape = this.state.orientation === 'landscape';
    return {
      id: dev.id,
      name: dev.name,
      width: landscape ? dev.h : dev.w,
      height: landscape ? dev.w : dev.h,
      dpr: dev.dpr,
      orientation: this.state.orientation,
    };
  }

  /**
   * Everything about this moment, in one dated folder.
   *
   * Gathered rather than demanded: whatever cannot be had — the page refuses a
   * screenshot, nothing is selected — is left out and named in the note, because a
   * partial record beats no record.
   */
  async collect(msg) {
    const url = this.currentUrl;
    const payload = { device: this.deviceInfo(), note: msg && msg.note };

    if (this.capturer && this.capturer.available) {
      try {
        const shot = await this.capturer.shot(this.captureOptions({ mode: 'frame', name: 'collected' }));
        payload.screenshot = shot.buffer;
      } catch (err) {
        this.output.appendLine('collect: no screenshot — ' + err.message);
      }
      if (msg && msg.fullPage) {
        try {
          const full = await this.capturer.shot(this.captureOptions({ mode: 'full', scale: 1 }));
          payload.fullPage = full.buffer;
        } catch (err) {
          this.output.appendLine('collect: no full-page shot — ' + err.message);
        }
      }
    }

    const html = await this.ask({ type: 'dp:cmd:html' }, 'dp:html', 8000);
    if (html && html.html) payload.html = html.html;
    else this.output.appendLine('collect: no markup — ' + ((html && html.error) || 'the page did not answer'));

    payload.console = this.consoleLog.slice(-400);
    if (this.selection) payload.element = this.selection;

    const result = this.library.collect(url, payload);
    this.post({ type: 'collected', dir: result.dir, files: result.files });
    return result;
  }

  /** Reveal a folder in the file manager. */
  openPath(target) {
    if (!target) return;
    vscode.env.openExternal(vscode.Uri.file(target)).then(undefined, err => {
      this.output.appendLine('could not open ' + target + ': ' + (err && err.message ? err.message : err));
    });
  }

  /**
   * One clipboard paste that gives an AI agent everything about the selected element:
   * what it is, where it is, how it is styled, its markup, and a path to a
   * screenshot with it ringed — which the agent can open directly.
   */
  async elementForAI(msg) {
    const el = msg.element || {};
    let shotFile = '';
    if (this.capturer && this.capturer.available) {
      try {
        const shot = await this.capturer.shot({
          url: this.currentUrl,
          device: msg.device && msg.device.id,
          orientation: msg.device && msg.device.orientation,
          mode: 'frame',
          selector: el.selector,
          name: 'element',
        });
        shotFile = shot.file;
      } catch (err) {
        this.output.appendLine('element screenshot failed: ' + err.message);
      }
    }

    const styles = Object.entries(el.styles || {})
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');

    const device = msg.device || {};
    const report = [
      `## Element selected in Custom AI View`,
      '',
      `- **Device:** ${device.name || 'unknown'} — ${device.width}×${device.height} pt @${device.dpr}x, ${device.orientation}`,
      `- **Page:** ${el.url || this.currentUrl}`,
      `- **Element:** \`${el.name}\``,
      `- **Selector:** \`${el.selector}\``,
      `- **Box:** ${Math.round(el.rect ? el.rect.width : 0)} × ${Math.round(el.rect ? el.rect.height : 0)} at (${Math.round(el.rect ? el.rect.x : 0)}, ${Math.round(el.rect ? el.rect.y : 0)})`,
      el.ancestors && el.ancestors.length ? `- **Path:** ${el.ancestors.join(' › ')} › ${el.name}` : '',
      el.text ? `- **Text:** ${el.text}` : '',
      shotFile ? `- **Screenshot with the element ringed:** ${shotFile}` : '',
      '',
      styles ? '### Computed styles\n\n```css\n' + (el.selector || 'element') + ' {\n' + styles + '\n}\n```' : '',
      '',
      '### Markup',
      '',
      '```html',
      el.html || '',
      '```',
      el.truncated ? '\n_(markup truncated at 6000 characters)_' : '',
    ]
      .filter(line => line !== '')
      .join('\n');

    await vscode.env.clipboard.writeText(report);

    this.post({
      type: 'captured',
      kind: 'screenshot',
      file: shotFile || '(no screenshot)',
      width: Math.round(el.rect ? el.rect.width : 0),
      height: Math.round(el.rect ? el.rect.height : 0),
      clipboard: false,
    });

    vscode.window.setStatusBarMessage('$(check) Element copied for AI', 3000);
  }

  updateTitle(deviceName) {
    this.panel.title = deviceName ? `${deviceName} — Custom AI View` : 'Custom AI View';
  }

  async refreshPorts() {
    try {
      // What is actually listening and actually serves pages, rather than a guess at
      // which ports a dev server might have chosen.
      const extra = (vscode.workspace.getConfiguration('customAIView').get('extraPorts') || [])
        .map(p => parseInt(p, 10))
        .filter(p => p > 0 && p < 65536);
      const found = await discoverDevServers(extra);
      // A dev server on https signs with a certificate nothing trusts, and its icon
      // will not load directly. The proxy terminates that for loopback.
      await this.proxy.start();
      this.post({
        type: 'ports',
        ports: found.map(s => Object.assign({}, s, { icon: s.icon ? this.proxy.wrap(s.icon) : '' })),
      });
    } catch (err) {
      this.output.appendLine(`port scan failed: ${err.message}`);
    }
  }

  /** Normalise whatever the user typed into something loadable. */
  normalize(input) {
    let raw = String(input || '').trim();
    if (!raw) return '';
    // Match a scheme only with its slashes, or from a known slashless set. A bare
    // `scheme:` test would swallow `localhost:3000` and `C:\dir\page.html`, both of
    // which look exactly like a scheme followed by something.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    if (/^(mailto|tel|sms|data|about|javascript):/i.test(raw)) return raw;
    if (/^\d{2,5}$/.test(raw)) return `http://localhost:${raw}`;
    if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(raw)) {
      return `http://${raw}`;
    }
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(raw)) return `https://${raw}`;
    if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
      return vscode.Uri.file(raw).toString();
    }
    // treat as a search-free fallback: assume it is a host
    return `https://${raw}`;
  }

  /** Decide direct vs proxied, start the proxy if needed, hand the webview a URL. */
  async navigate(input, force, opts) {
    const url = this.normalize(input);
    if (!url) return;

    if (url.startsWith('file:')) {
      const uri = vscode.Uri.parse(url);
      const webUri = this.panel.webview.asWebviewUri(uri).toString();
      this.post({ type: 'load', url: webUri, real: url, proxied: false, kind: 'file' });
      return;
    }

    if (!/^https?:/i.test(url)) {
      this.post({ type: 'load', url, real: url, proxied: false, kind: 'other' });
      return;
    }

    const cfg = this.config();
    const mode = force || cfg.touchEmulation || 'auto';
    let useProxy = mode === 'always';
    let reason = '';

    // A webview is a secure context, so a plain-http iframe is blocked as mixed
    // content — except on loopback, which is exempt. The proxy listens on
    // 127.0.0.1, so routing through it is what makes such a page loadable at all.
    if (isMixedContent(url)) {
      useProxy = true;
      reason = 'plain http would be blocked as mixed content';
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
      try {
        await this.proxy.start();
        this.proxy.setProfile(this.profileForState());
        finalUrl = this.proxy.wrap(url);
        finalUrl = await this.external(finalUrl);
        if (reason) this.output.appendLine(`proxying ${url} — ${reason}`);
      } catch (err) {
        this.output.appendLine(`proxy failed, falling back to direct: ${err.message}`);
        vscode.window.showWarningMessage(`Custom AI View: proxy could not start (${err.message}). Loading directly.`);
        useProxy = false;
        finalUrl = url;
      }
    } else {
      finalUrl = await this.external(url);
    }

    this.currentUrl = url;
    this.pushHistory(url);
    this.saveState({ lastUrl: url, lastProxied: useProxy });

    // Re-assigning an identical src is a no-op for the browser, so a hard reload of
    // the page that is already loaded needs the URL to differ by something the
    // proxy strips before it goes upstream.
    if (opts && opts.cacheBust) {
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + '__dp_r=' + Date.now().toString(36);
    }

    this.post({ type: 'load', url: finalUrl, real: url, proxied: useProxy, kind: 'web' });
  }

  /**
   * Tunnel loopback URLs through the remote-development port forwarder.
   *
   * WebviewOptions.portMapping cannot help here: it is implemented in the webview's
   * service worker, which only intercepts requests from clients it controls, and a
   * cross-origin nested iframe is not one. asExternalUri is a no-op locally, so it
   * is safe to call unconditionally — but the tunnel it returns is short-lived, so
   * the result is never persisted and is re-resolved on every navigation.
   */
  async external(url) {
    try {
      const uri = vscode.Uri.parse(url);
      const host = uri.authority.replace(/:\d+$/, '').toLowerCase();
      if (!LOOPBACK.has(host)) return url;
      const ext = await vscode.env.asExternalUri(uri);
      return ext.toString(true);
    } catch {
      return url;
    }
  }

  profileForState() {
    const dev = byId(this.state.deviceId || this.config().defaultDevice);
    const landscape = this.state.orientation === 'landscape';
    const os = dev.os === 'ipados' ? 'ipados' : dev.os === 'android' ? 'android' : dev.os === 'macos' ? 'macos' : dev.os === 'ios' ? 'ios' : 'generic';
    const c = vscode.workspace.getConfiguration('customAIView');
    const overrides = { ios: c.get('userAgent.ios'), android: c.get('userAgent.android') };
    return {
      os,
      ua: overrides[os] || UA[os] || UA.generic,
      platform: os === 'android' ? 'Linux armv8l' : os === 'macos' ? 'MacIntel' : 'iPhone',
      vendor: os === 'android' ? 'Google Inc.' : 'Apple Computer, Inc.',
      width: landscape ? dev.h : dev.w,
      height: landscape ? dev.w : dev.h,
      dpr: dev.dpr,
      orientation: this.state.orientation,
      touch: dev.kind === 'phone' || dev.kind === 'tablet',
      // A phone is driven by a fingertip, a Mac by a mouse — "auto" means exactly that.
      pointer: pointerFor(c.get('pointerStyle'), dev),
      forceViewport: !!this.config().forceMobileViewport,
      // The proxy substitutes these into every env(safe-area-inset-*) it sees,
      // which desktop Chromium would otherwise report as 0.
      // A tablet keeps its status bar — and its top inset — in landscape too.
      safeTop: landscape && !dev.homeButton && dev.kind !== 'tablet' ? 0 : dev.safeTop,
      safeBottom: landscape ? (dev.safeBottom ? 21 : 0) : dev.safeBottom,
      safeLeft: landscape ? dev.safeSide : 0,
      safeRight: landscape ? dev.safeSide : 0,
    };
  }

  /** Commands from the palette land here. */
  runCommand(name, payload) {
    this.post({ type: 'command', name, payload });
  }
}

module.exports = { DevicePanel, COMMON_PORTS };
