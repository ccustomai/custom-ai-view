'use strict';

const vscode = require('vscode');
const { DEVICES, byId, groups, oriented, KIND_LABEL } = require('./src/devices.js');
const { PreviewProxy, discoverDevServers } = require('./src/proxy.js');
const { DevicePanel, COMMON_PORTS } = require('./src/panel.js');
const { DeviceTreeProvider, CUTOUT_LABEL } = require('./src/tree.js');
const { ControlServer } = require('./src/control.js');

let proxy = null;
let output = null;
let statusItem = null;
let tree = null;
let control = null;

function activate(context) {
  output = vscode.window.createOutputChannel('Custom AI View');
  context.subscriptions.push(output);

  proxy = new PreviewProxy({
    port: vscode.workspace.getConfiguration('customAIView').get('proxyPort') || 0,
    mediaDir: vscode.Uri.joinPath(context.extensionUri, 'media').fsPath,
    log: msg => output.appendLine(msg),
  });
  context.subscriptions.push({ dispose: () => proxy.stop() });

  const activeDeviceId = () => {
    const panel = DevicePanel.current;
    if (panel && panel.state && panel.state.deviceId) return panel.state.deviceId;
    return vscode.workspace.getConfiguration('customAIView').get('defaultDevice');
  };

  const open = url => DevicePanel.createOrShow(context, proxy, output, url);

  tree = new DeviceTreeProvider(activeDeviceId);
  const treeView = vscode.window.createTreeView('customAIView.devices', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // One click on the logo in the activity bar should land you in the browser, not
  // in a list you then have to click again.
  context.subscriptions.push(
    treeView.onDidChangeVisibility(e => {
      if (!e.visible) return;
      if (vscode.workspace.getConfiguration('customAIView').get('openOnActivityBarClick') === false) return;
      open();
    })
  );

  registerLinkHandling(context, open);
  registerControlApi(context, open);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusItem.command = 'customAIView.open';
  statusItem.tooltip = 'Open Custom AI View';
  statusItem.text = '$(device-mobile) Custom AI View';
  context.subscriptions.push(statusItem);
  statusItem.show();

  const register = (name, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));

  register('customAIView.open', () => open());

  register('customAIView.openUrl', async () => {
    const panel = DevicePanel.current;
    const recent = panel ? panel.history() : context.globalState.get('customAIView.history.v1') || [];
    const value = await vscode.window.showInputBox({
      title: 'Open in Custom AI View',
      prompt: 'URL, host, or just a port number for a local dev server',
      placeHolder: recent[0] || 'localhost:5173',
      value: recent[0] || '',
      ignoreFocusOut: true,
    });
    if (value) open(value);
  });

  register('customAIView.openLocalhost', async () => {
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Scanning local dev-server ports…' },
      () => discoverDevServers(
        (vscode.workspace.getConfiguration('customAIView').get('extraPorts') || [])
          .map(p => parseInt(p, 10))
          .filter(p => p > 0 && p < 65536)
      )
    );
    if (!found.length) {
      const manual = await vscode.window.showInputBox({
        title: 'Nothing on this machine is serving web pages',
        prompt: 'Enter a port number',
        validateInput: v => (/^\d{2,5}$/.test(v.trim()) ? null : 'Enter a port number, e.g. 5173'),
      });
      if (manual) open(`localhost:${manual.trim()}`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      found.map(s => ({
        // The page's own title beats a guess from a table of common ports.
        label: `$(server-environment) localhost:${s.port}`,
        description: s.title || GUESS[s.port] || (s.scheme === 'https' ? 'https' : ''),
        url: `${s.scheme}://localhost:${s.port}`,
      })),
      { title: 'Local dev servers', placeHolder: 'Pick one to preview' }
    );
    if (pick) open(pick.url);
  });

  register('customAIView.openFile', async resource => {
    const uri = resource || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!uri) return void vscode.window.showWarningMessage('Custom AI View: no file to preview.');
    open(uri.toString());
  });

  register('customAIView.pickDevice', async () => {
    const items = [];
    for (const group of groups()) {
      items.push({ label: group.name, kind: vscode.QuickPickItemKind.Separator });
      for (const dev of group.items) {
        items.push({
          label: `${dev.name}`,
          description: `${dev.w} × ${dev.h}  ·  @${dev.dpr}x`,
          detail: `${Math.round(dev.w * dev.dpr)} × ${Math.round(dev.h * dev.dpr)} px  ·  ${
            CUTOUT_LABEL[dev.cutout] || dev.cutout
          }  ·  safe area ${dev.safeTop}/${dev.safeBottom}`,
          id: dev.id,
        });
      }
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Select a device',
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Search by name or size, e.g. "393" or "Pro Max"',
    });
    if (pick && pick.id) selectDevice(pick.id);
  });

  register('customAIView.selectDevice', id => selectDevice(id));

  register('customAIView.openUri', url => open(typeof url === 'string' ? url : String(url)));

  register('customAIView.rotate', () => withPanel(p => p.runCommand('rotate')));
  register('customAIView.reload', () => withPanel(p => p.runCommand('reload', { mode: 'normal' })));
  register('customAIView.reloadHard', () => withPanel(p => p.runCommand('reload', { mode: 'hard' })));
  register('customAIView.reloadPurge', () => withPanel(p => p.runCommand('reload', { mode: 'purge' })));
  register('customAIView.nextDevice', () => withPanel(p => p.runCommand('step-device', { delta: 1 })));
  register('customAIView.prevDevice', () => withPanel(p => p.runCommand('step-device', { delta: -1 })));
  register('customAIView.toggleTouch', () => withPanel(p => p.runCommand('toggle-touch')));
  register('customAIView.toggleGrid', () => withPanel(p => p.runCommand('toggle-grid')));
  register('customAIView.copyUrl', () => withPanel(p => p.runCommand('copy-url')));
  register('customAIView.screenshot', () => withPanel(p => p.runCommand('capture', { mode: 'frame' })));
  register('customAIView.screenshotFull', () => withPanel(p => p.runCommand('capture', { mode: 'full' })));
  register('customAIView.record', () => withPanel(p => p.runCommand('record', { durationMs: 5000, fps: 10 })));
  register('customAIView.toggleInspect', () => withPanel(p => p.runCommand('toggle-inspect')));
  register('customAIView.copyElement', () => withPanel(p => p.runCommand('copy-element')));

  register('customAIView.mcpCommand', async () => {
    const serverPath = vscode.Uri.joinPath(context.extensionUri, 'mcp', 'server.js').fsPath;
    const cmd = `claude mcp add custom-ai-view --scope user -- node "${serverPath}"`;
    const pick = await vscode.window.showInformationMessage(
      'Register the Custom AI View MCP server with Claude Code by running this once in a terminal.',
      'Copy command',
      'Run in terminal'
    );
    if (pick === 'Copy command') {
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.setStatusBarMessage('$(check) Command copied', 3000);
    } else if (pick === 'Run in terminal') {
      const term = vscode.window.createTerminal('Custom AI View MCP');
      term.show();
      term.sendText(cmd);
    }
  });

  register('customAIView.refreshDevices', () => tree.refresh());
  register('customAIView.showProxyLog', () => output.show(true));

  register('customAIView.openExternal', () => {
    const panel = DevicePanel.current;
    if (panel && panel.currentUrl) vscode.env.openExternal(vscode.Uri.parse(panel.currentUrl));
    else vscode.window.showInformationMessage('Custom AI View: nothing loaded yet.');
  });

  function withPanel(fn) {
    const panel = DevicePanel.current || open();
    fn(panel);
  }

  function selectDevice(id) {
    const dev = byId(id);
    const panel = DevicePanel.current || open();
    panel.saveState({ deviceId: dev.id });
    panel.runCommand('set-device', { deviceId: dev.id });
    panel.updateTitle(dev.name);
    statusItem.text = `$(device-mobile) ${dev.name}`;
    tree.refresh();
  }

  const initial = byId(activeDeviceId());
  statusItem.text = `$(device-mobile) ${initial.name}`;
}

/**
 * The door the MCP server knocks on, so Claude gets the same view and the same
 * controls the person has. Every route works whether or not a panel is open: the
 * ones that need pixels drive a headless browser through the same proxy.
 */
function registerControlApi(context, open) {
  const cfg = () => vscode.workspace.getConfiguration('customAIView');
  if (cfg().get('controlApi') === false) return;

  const panelOrDefaults = () => {
    const panel = DevicePanel.current;
    return {
      panel,
      url: panel ? panel.currentUrl : '',
      device: panel && panel.state.deviceId ? panel.state.deviceId : cfg().get('defaultDevice'),
      orientation: panel ? panel.state.orientation : 'portrait',
      custom: panel ? panel.state.custom : undefined,
    };
  };

  /** Screenshot and inspection need a Capturer even with no panel open. */
  const capturerFor = () => {
    const panel = DevicePanel.current || open();
    return panel.capturer;
  };

  /**
   * Anything that touches the page the person is actually looking at. Unlike a
   * screenshot, this cannot be answered by a headless copy — it has to go to the
   * open panel, so it needs one.
   */
  const live = async (body, message, replyType) => {
    const panel = DevicePanel.current;
    if (!panel) throw new Error('Open the Custom AI View panel first — this reaches into the live page.');
    const result = await panel.ask(message, replyType, body.timeout);
    if (result && result.error) throw new Error(result.error);
    return result;
  };

  const merge = (body, base) => ({
    url: body.url || base.url,
    device: body.device || base.device,
    orientation: body.orientation || base.orientation,
    custom: base.custom,
    finish: cfg().get('deviceFinish'),
    statusBar: cfg().get('statusBarStyle'),
    statusBarLayout: cfg().get('statusBarLayout'),
    browserChrome: cfg().get('browserChrome'),
    clock: cfg().get('clock') === 'real' ? undefined : cfg().get('customClock') || '9:41',
  });

  control = new ControlServer({
    log: msg => output.appendLine(msg),
    routes: {
      '/state': async () => {
        const base = panelOrDefaults();
        const dev = oriented(byId(base.device), base.orientation, base.custom);
        return {
          open: !!base.panel,
          url: base.url,
          device: { id: dev.id, name: dev.name, width: dev.w, height: dev.h, dpr: dev.dpr },
          orientation: base.orientation,
          proxied: base.panel ? !!base.panel.state.lastProxied : false,
          selection: base.panel && base.panel.selection
            ? {
                name: base.panel.selection.name,
                selector: base.panel.selection.selector,
                rect: base.panel.selection.rect,
              }
            : null,
          captureAvailable: base.panel ? base.panel.capturer.available : false,
        };
      },

      '/devices': async body => {
        const filter = String(body.filter || '').toLowerCase();
        return {
          devices: DEVICES.filter(
            d => !filter || (d.name + ' ' + d.id).toLowerCase().includes(filter)
          ).map(d => ({
            id: d.id,
            name: d.name,
            width: d.w,
            height: d.h,
            dpr: d.dpr,
            safeTop: d.safeTop,
            safeBottom: d.safeBottom,
            cutout: d.cutout,
          })),
        };
      },

      '/open': async body => {
        const panel = DevicePanel.current || open();
        if (body.device) {
          panel.saveState({ deviceId: byId(body.device).id });
          panel.runCommand('set-device', { deviceId: byId(body.device).id });
        }
        if (body.orientation && body.orientation !== panel.state.orientation) {
          panel.runCommand('rotate');
        }
        if (body.url) await panel.navigate(body.url);
        return { url: panel.currentUrl || body.url || '', device: byId(panel.state.deviceId || cfg().get('defaultDevice')).name };
      },

      '/device': async body => {
        const panel = DevicePanel.current || open();
        if (body.device) {
          const dev = byId(body.device);
          panel.saveState({ deviceId: dev.id });
          panel.runCommand('set-device', { deviceId: dev.id });
        }
        if (body.orientation && body.orientation !== panel.state.orientation) panel.runCommand('rotate');
        const dev = oriented(byId(panel.state.deviceId), panel.state.orientation, panel.state.custom);
        return { device: dev.name, width: dev.w, height: dev.h };
      },

      '/reload': async body => {
        const panel = DevicePanel.current || open();
        panel.runCommand('reload', { mode: body.mode || 'normal' });
        return { ok: true };
      },

      '/screenshot': async body => {
        const base = panelOrDefaults();
        const capturer = capturerFor();
        if (!capturer.available) throw new Error('No Chrome or Edge found. Set customAIView.chromePath.');
        const shot = await capturer.shot(
          Object.assign(merge(body, base), {
            mode: body.mode || 'frame',
            selector: body.selector,
            scale: body.scale,
            name: body.mode || 'frame',
          })
        );
        return {
          file: shot.file,
          width: shot.width,
          height: shot.height,
          mode: shot.mode,
          // Inlined so the model can actually look at it, not just read a path.
          data: body.inline === false ? undefined : shot.buffer.toString('base64'),
        };
      },

      '/inspect': async body => {
        const base = panelOrDefaults();
        const panel = DevicePanel.current;
        let selector = body.selector;
        if (!selector && panel && panel.selection) selector = panel.selection.selector;
        if (!selector) throw new Error('No selector given and nothing is selected in the panel.');

        const capturer = capturerFor();
        if (!capturer.available) throw new Error('No Chrome or Edge found. Set customAIView.chromePath.');
        const el = await capturer.describe(Object.assign(merge(body, base), { selector }));

        const styles = Object.entries(el.styles || {}).map(([k, v]) => `  ${k}: ${v};`).join('\n');
        return {
          element: el,
          report: [
            `Element: ${el.name}`,
            `Selector: ${el.selector}`,
            `Box: ${Math.round(el.rect.width)} × ${Math.round(el.rect.height)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})`,
            el.ancestors && el.ancestors.length ? `Path: ${el.ancestors.join(' > ')} > ${el.name}` : '',
            el.text ? `Text: ${el.text}` : '',
            '',
            styles ? 'Computed styles:\n```css\n' + el.selector + ' {\n' + styles + '\n}\n```' : '',
            '',
            'Markup:\n```html\n' + (el.html || '') + '\n```',
          ].filter(Boolean).join('\n'),
        };
      },

      '/record': async body => {
        const base = panelOrDefaults();
        const capturer = capturerFor();
        if (!capturer.available) throw new Error('No Chrome or Edge found for recording.');
        const clip = await capturer.record(
          Object.assign(merge(body, base), {
            durationMs: body.durationMs,
            fps: body.fps,
            name: 'recording',
          })
        );
        return { file: clip.file, frames: clip.frames, fps: clip.fps };
      },

      // A take of no fixed length: started here, stopped here, bounded by disk
      // rather than by an argument decided before anyone knew how long it would run.
      '/record/start': async body => {
        const base = panelOrDefaults();
        const capturer = capturerFor();
        if (!capturer.available) throw new Error('No Chrome or Edge found for recording.');
        const started = await capturer.startRecording(
          Object.assign(merge(body, base), { fps: body.fps, name: body.name || 'recording' })
        );
        const panel = DevicePanel.current;
        if (panel) panel.post({ type: 'recording-state', recording: true, seconds: 0, libraryRoot: panel.library.root });
        return started;
      },

      '/record/stop': async () => {
        const capturer = capturerFor();
        const clip = await capturer.stopRecording();
        const panel = DevicePanel.current;
        if (panel) panel.post({ type: 'recording-state', recording: false });
        return { file: clip.file, frames: clip.frames, fps: clip.fps, seconds: clip.seconds };
      },

      '/record/status': async () => capturerFor().recordingStatus(),

      '/collect': async body => {
        const panel = DevicePanel.current || open();
        return panel.collect(body);
      },

      '/library': async () => {
        const panel = DevicePanel.current || open();
        return { root: panel.library.root, sites: panel.library.sites() };
      },

      '/library/root': async body => {
        if (!body.path) {
          const panel = DevicePanel.current || open();
          return { root: panel.library.root };
        }
        // The root describes where this person keeps their material, not this
        // workspace's, so it is written globally.
        await cfg().update('captureDirectory', body.path, vscode.ConfigurationTarget.Global);
        const panel = DevicePanel.current;
        if (panel) panel.library.setRoot(body.path);
        return { root: body.path };
      },

      '/console': async body => {
        const panel = DevicePanel.current;
        if (!panel) return { entries: [] };
        const limit = Math.min(400, Math.max(1, body.limit || 50));
        return { entries: panel.consoleLog.slice(-limit) };
      },

      // Reaching into the live page: search it, drive it, change it.
      '/find': async body => live(body, {
        type: 'dp:cmd:find', selector: body.selector, text: body.text, limit: body.limit,
      }, 'dp:found'),

      '/edit': async body => {
        const spec = {
          selector: body.selector, style: body.style, text: body.text, html: body.html,
          attrs: body.attrs, addClass: body.addClass, removeClass: body.removeClass,
          remove: body.remove,
        };
        const result = await live(body, Object.assign({ type: 'dp:cmd:edit' }, spec), 'dp:edited');
        // Only a change that actually landed is worth replaying on the next load.
        if (result && result.ok && body.persist !== false) proxy.rememberEdit(spec);
        return Object.assign({}, result, { persisted: body.persist !== false, edits: proxy.edits.length });
      },

      '/edits': async () => ({ edits: proxy.edits }),

      '/revert': async () => {
        const count = proxy.clearEdits();
        const panel = DevicePanel.current;
        // The page still holds the old changes, so it has to be re-fetched.
        if (panel) panel.runCommand('reload', { mode: 'normal' });
        return { cleared: count };
      },

      '/tree': async body => live(body, { type: 'dp:cmd:tree', path: body.path || [] }, 'dp:tree'),

      '/click': async body => live(body, {
        type: 'dp:cmd:input', kind: 'click', selector: body.selector,
      }, 'dp:input-done'),

      '/type': async body => live(body, {
        type: 'dp:cmd:input', kind: 'type', selector: body.selector, text: body.text,
      }, 'dp:input-done'),

      '/scroll': async body => live(body, {
        type: 'dp:cmd:input', kind: 'scroll', selector: body.selector,
        dx: body.dx || 0, dy: body.dy || 0,
      }, 'dp:input-done'),
    },
  });

  control
    .start(cfg().get('controlPort') || 0)
    .then(port => output.appendLine('control api ready on port ' + port))
    .catch(err => output.appendLine('control api failed to start: ' + err.message));

  context.subscriptions.push({ dispose: () => control && control.stop() });
}

/**
 * Route links elsewhere in VS Code into the preview.
 *
 * Three routes, because no single stable API covers everything:
 *   - terminal links, which is where dev-server URLs actually appear
 *   - the external-URI opener, which covers markdown previews and notebooks but is
 *     a proposed API, so it is attempted and ignored when unavailable
 *   - a document-link provider, so Ctrl+click on a URL in an editor lands here
 */
function registerLinkHandling(context, open) {
  const mode = () => vscode.workspace.getConfiguration('customAIView').get('linkHandling') || 'always';

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks(ctx) {
        if (mode() === 'never') return [];
        const links = [];
        const re = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
        let m;
        while ((m = re.exec(ctx.line)) !== null) {
          const url = m[0].replace(/[.,;:!?]+$/, '');
          links.push({
            startIndex: m.index,
            length: url.length,
            tooltip: 'Open in Custom AI View',
            data: url,
          });
        }
        return links;
      },
      handleTerminalLink(link) {
        open(link.data);
      },
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { scheme: '*' },
      {
        provideDocumentLinks(document) {
          if (mode() === 'never') return [];
          if (document.lineCount > 5000) return [];
          const links = [];
          const re = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
          const text = document.getText();
          let m;
          while ((m = re.exec(text)) !== null && links.length < 400) {
            const url = m[0].replace(/[.,;:!?]+$/, '');
            const range = new vscode.Range(
              document.positionAt(m.index),
              document.positionAt(m.index + url.length)
            );
            const link = new vscode.DocumentLink(
              range,
              vscode.Uri.parse('command:customAIView.openUri?' + encodeURIComponent(JSON.stringify([url])))
            );
            link.tooltip = 'Open in Custom AI View';
            links.push(link);
          }
          return links;
        },
      }
    )
  );

  // Proposed API in stable builds; harmless to attempt, valuable where it exists.
  try {
    if (typeof vscode.window.registerExternalUriOpener === 'function' && vscode.ExternalUriOpenerPriority) {
      context.subscriptions.push(
        vscode.window.registerExternalUriOpener(
          'customAIView.opener',
          {
            canOpenExternalUri() {
              const m = mode();
              if (m === 'never') return vscode.ExternalUriOpenerPriority.None;
              if (m === 'always') return vscode.ExternalUriOpenerPriority.Preferred;
              return vscode.ExternalUriOpenerPriority.Option;
            },
            openExternalUri(uri) {
              open(uri.toString(true));
            },
          },
          { schemes: ['http', 'https'], label: 'Open in Custom AI View' }
        )
      );
    }
  } catch (err) {
    output.appendLine('external uri opener unavailable: ' + err.message);
  }
}

const GUESS = {
  3000: 'Next.js · Create React App · Express',
  4200: 'Angular',
  4321: 'Astro',
  5000: 'Flask · .NET',
  5173: 'Vite',
  8000: 'Django · Python http.server',
  8080: 'Webpack · Tomcat',
  8100: 'Ionic',
  1313: 'Hugo',
  1234: 'Parcel',
};

function deactivate() {
  if (proxy) proxy.stop();
  if (control) control.stop();
}

module.exports = { activate, deactivate };
