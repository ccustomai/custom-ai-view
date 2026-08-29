/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Panel application.
 *
 * Owns the toolbar, the stage, zoom fitting, the device picker and the two-way
 * traffic with the extension host and with the page inside the frame.
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var Catalog = window.DeviceCatalog;
  var Frame = window.DeviceFrame;

  var $ = function (id) { return document.getElementById(id); };
  var toolbarEl = $('toolbar');
  var stageEl = $('stage');
  var stageInner = $('stageInner');
  var popoverEl = $('popover');
  var toastEl = $('toast');
  var selectionEl = $('selection');
  var carouselEl = $('carousel');
  var devtoolsEl = $('devtools');
  var appEl = $('app');

  var state = {
    deviceId: 'iphone-16-pro',
    orientation: 'portrait',
    zoom: 'fit',
    mode: 'single',
    custom: { w: 400, h: 800, dpr: 2 },
    finish: 'graphite',
    statusBar: 'auto',
    statusBarLayout: 'inset',
    browserChrome: false,
    background: 'studio',
    shadow: true,
    showLabel: true,
    glare: true,
    clock: 'real',
    customClock: '9:41',
    touchEmulation: 'always',
    gridDevices: ['iphone-se-3', 'iphone-16-pro', 'galaxy-s24', 'ipad-pro-11-m4'],
    url: '',
    realUrl: '',
    proxied: false,
    inspect: false,
    selection: null,
    display: null,
    calibration: 1,
  };

  var frames = [];
  var primary = null;
  var history = [];
  var back = [];
  var forward = [];
  var ports = [];
  var startPageUrl = (window.__DP_ASSETS__ || {}).start || '';
  var blockedTimer = 0;

  // ------------------------------------------------------------------ icons

  function icon(name) {
    var paths = {
      back: '<path d="M9.5 3 5 8l4.5 5"/>',
      forward: '<path d="M6.5 3 11 8l-4.5 5"/>',
      reload: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2v3.2H10"/>',
      reloadHard: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2v3.2H10"/><path d="M6.2 6.4 8 8.2l1.8-1.8"/><path d="M8 8.2V4.6"/>',
      trash: '<path d="M2.8 4.2h10.4"/><path d="M6.4 4.2V2.8h3.2v1.4"/><path d="M4.2 4.2l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2"/><path d="M6.8 6.8v4M9.2 6.8v4"/>',
      stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
      home: '<path d="M2.6 7.4 8 2.8l5.4 4.6"/><path d="M4.2 7v6.2h7.6V7"/>',
      rotate: '<rect x="3.2" y="1.8" width="9.6" height="12.4" rx="2"/><path d="M6.4 12.4h3.2"/>',
      rotateLand: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2"/><path d="M12.4 6.4v3.2"/>',
      zoom: '<circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6 14 14"/><path d="M5 7h4M7 5v4"/>',
      touch: '<path d="M6.5 8.4V3.6a1.4 1.4 0 0 1 2.8 0v6.2"/><path d="M9.3 7.2a1.3 1.3 0 0 1 2.6 0v3.2a3.6 3.6 0 0 1-3.6 3.6H7.4A3.4 3.4 0 0 1 4 10.6l-.6-2a1.2 1.2 0 0 1 2.1-1.1"/>',
      grid: '<rect x="1.6" y="2.2" width="5" height="11.6" rx="1.4"/><rect x="9.4" y="2.2" width="5" height="11.6" rx="1.4"/>',
      chrome: '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2"/><path d="M1.6 6h12.8"/><circle cx="4" cy="4.3" r=".7" fill="currentColor"/>',
      palette: '<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.4-.6 1.4-1.3 0-.8-.7-1.1-.7-1.8 0-.6.5-1 1.1-1h1.3A3.1 3.1 0 0 0 14.2 7 5.6 5.6 0 0 0 8 1.8Z"/><circle cx="5.2" cy="6.4" r=".9" fill="currentColor"/><circle cx="8" cy="4.8" r=".9" fill="currentColor"/><circle cx="10.8" cy="6.4" r=".9" fill="currentColor"/>',
      more: '<circle cx="3.2" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.8" cy="8" r="1.2" fill="currentColor"/>',
      external: '<path d="M9.4 2.6h4v4"/><path d="M13.4 2.6 7.6 8.4"/><path d="M12 9.6v3.2a.9.9 0 0 1-.9.9H3.3a.9.9 0 0 1-.9-.9V5a.9.9 0 0 1 .9-.9h3.2"/>',
      device: '<rect x="4.2" y="1.6" width="7.6" height="12.8" rx="1.8"/><path d="M6.9 12.6h2.2"/>',
      caret: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
      check: '<path d="M3.2 8.4 6.4 11.6l6.4-7.2"/>',
      server: '<rect x="2" y="2.6" width="12" height="4.4" rx="1.3"/><rect x="2" y="9" width="12" height="4.4" rx="1.3"/><circle cx="4.6" cy="4.8" r=".8" fill="currentColor"/><circle cx="4.6" cy="11.2" r=".8" fill="currentColor"/>',
      inspect: '<path d="M2.6 2.6h3M2.6 2.6v3M13.4 2.6h-3M13.4 2.6v3M2.6 13.4h3M2.6 13.4v-3M13.4 13.4h-3M13.4 13.4v-3"/><rect x="6" y="6" width="4" height="4" rx="1"/>',
      camera: '<path d="M2 5.6h2.4l1-1.8h5.2l1 1.8H14v7.2H2z"/><circle cx="8" cy="9" r="2.4"/>',
      copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1.6"/><path d="M10.6 5.4V3.8a1.2 1.2 0 0 0-1.2-1.2H4a1.2 1.2 0 0 0-1.2 1.2v5.4a1.2 1.2 0 0 0 1.2 1.2h1.4"/>',
      record: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4" fill="currentColor"/>',
      close: '<path d="M4 4l8 8M12 4l-8 8"/>',
      newWindow: '<rect x="1.6" y="3.4" width="9" height="9" rx="1.6"/><path d="M5.4 3.4V2.2a.8.8 0 0 1 .8-.8h7.2a.8.8 0 0 1 .8.8v7.2a.8.8 0 0 1-.8.8h-1.2"/><path d="M6.1 7.9h4M8.1 5.9v4"/>',
      code: '<path d="M5.6 4.4 2.2 8l3.4 3.6M10.4 4.4 13.8 8l-3.4 3.6M9.2 3l-2.4 10"/>',
      folder: '<path d="M1.8 12.6V4.2a1 1 0 0 1 1-1h3l1.6 1.8h5.8a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z"/>',
      dockRight: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M9.6 2.6v10.8"/>',
      dockBottom: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M1.8 9.4h12.4"/>',
      sun: '<circle cx="8" cy="8" r="3.2"/><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>',
    };
    return (
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (paths[name] || '') + '</svg>'
    );
  }

  // --------------------------------------------------------------- toolbar

  function buildToolbar() {
    toolbarEl.innerHTML =
      '<div class="tb-group">' +
        btn('nav-back', 'back', 'Back') +
        btn('nav-forward', 'forward', 'Forward') +
        btn('nav-reload', 'reload', 'Reload  (Ctrl+R)') +
        '<button class="tb-btn tb-caret" id="nav-reload-menu" title="Reload options" ' +
          'aria-label="Reload options">' + icon('caret') + '</button>' +
        btn('nav-home', 'home', 'Start page') +
      '</div>' +
      '<div class="tb-url">' +
        '<span class="badge" id="urlBadge" data-kind="direct">direct</span>' +
        '<input id="urlInput" type="text" spellcheck="false" autocomplete="off" ' +
        'placeholder="localhost:5173 · example.com · 3000" aria-label="Address">' +
      '</div>' +
      '<div class="tb-sep"></div>' +
      '<div class="tb-group">' +
        '<button class="tb-btn tb-device" id="deviceBtn" title="Select device (Ctrl+D)">' +
          icon('device') + '<b id="deviceName">iPhone</b> <span class="size" id="deviceSize"></span>' +
          '<span class="caret">' + icon('caret') + '</span></button>' +
        btn('rotateBtn', 'rotate', 'Rotate  (Ctrl+Alt+R)') +
        '<button class="tb-btn" id="zoomBtn" title="Zoom">' + icon('zoom') +
          '<span id="zoomLabel">Fit</span><span class="caret">' + icon('caret') + '</span></button>' +
      '</div>' +
      '<div class="tb-sep"></div>' +
      '<div class="tb-group">' +
        btn('inspectBtn', 'inspect', 'Inspect elements — hover to outline, click to select') +
        btn('devtoolsBtn', 'code', 'Elements, console and styles  (Ctrl+Shift+C)') +
        // Press it for a shot, press the caret for everything else. Which shape it
        // takes is the toggle in that menu, and the tooltip says which is armed.
        '<button class="tb-btn" id="shotBtn" title="Take a screenshot">' + icon('camera') + '</button>' +
        '<button class="tb-btn" id="cameraBtn" title="Screenshot and recording">' +
          '<span class="caret">' + icon('caret') + '</span></button>' +
      '</div>' +
      '<div class="tb-sep"></div>' +
      '<div class="tb-group">' +
        btn('touchBtn', 'touch', 'Touch emulation — synthesised touch events, mobile User-Agent, drag to scroll') +
        btn('chromeBtn', 'chrome', 'Show the browser UI and shrink the viewport to match') +
        btn('gridBtn', 'grid', 'Multi-device wall') +
        btn('appearanceBtn', 'palette', 'Appearance') +
        // Only the standalone app can put a second device on the desktop; inside
        // VS Code a preview is a tab, and the editor already owns splitting.
        (window.__DP_STANDALONE__
          ? btn('newWindowBtn', 'newWindow', 'Open another window — same page, any device')
          : '') +
        btn('moreBtn', 'more', 'More') +
      '</div>';

    on('nav-back', 'click', goBack);
    on('nav-forward', 'click', goForward);
    on('nav-reload', 'click', function () { reload('normal'); });
    on('nav-reload-menu', 'click', function (e) { openReloadMenu(e.currentTarget); });
    on('nav-home', 'click', function () { loadStartPage(); });
    on('deviceBtn', 'click', function () {
      if (carouselEl.hidden) openDeviceCarousel();
      else closeCarousel();
    });
    on('rotateBtn', 'click', rotate);
    on('zoomBtn', 'click', function (e) { openZoomMenu(e.currentTarget); });
    on('inspectBtn', 'click', toggleInspect);
    on('devtoolsBtn', 'click', function () { toggleDevtools(); });
    on('cameraBtn', 'click', function (e) { openCameraMenu(e.currentTarget); });
    on('shotBtn', 'click', function () {
      capture(state.framedShots === false ? 'screen' : 'frame');
    });
    on('touchBtn', 'click', toggleTouch);
    on('chromeBtn', 'click', function () {
      state.browserChrome = !state.browserChrome;
      persist();
      renderStage();
    });
    on('gridBtn', 'click', toggleGrid);
    on('appearanceBtn', 'click', function (e) { openAppearanceMenu(e.currentTarget); });
    on('newWindowBtn', 'click', function () {
      vscode.postMessage({ type: 'new-window', url: state.realUrl, device: state.deviceId });
    });
    on('moreBtn', 'click', function (e) { openMoreMenu(e.currentTarget); });

    var input = $('urlInput');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigate(input.value);
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = state.realUrl || '';
        input.blur();
      }
    });
    input.addEventListener('focus', function () { input.select(); });
  }

  function btn(id, ic, title) {
    return '<button class="tb-btn" id="' + id + '" title="' + title.replace(/"/g, '&quot;') + '" aria-label="' +
      title.replace(/"/g, '&quot;') + '">' + icon(ic) + '</button>';
  }

  function on(id, ev, fn) {
    var node = $(id);
    if (node) node.addEventListener(ev, fn);
  }

  function updateToolbar() {
    var dev = Catalog.byId(state.deviceId);
    var o = Catalog.oriented(dev, state.orientation, state.custom);
    $('deviceName').textContent = dev.name;
    $('deviceSize').textContent = o.w + '×' + o.h;
    $('zoomLabel').textContent = state.zoom === 'fit' ? 'Fit'
      : state.zoom === 'actual' ? '1:1'
      : Math.round(state.zoom * 100) + '%';
    $('rotateBtn').innerHTML = icon(state.orientation === 'landscape' ? 'rotateLand' : 'rotate');
    $('rotateBtn').setAttribute('aria-pressed', state.orientation === 'landscape' ? 'true' : 'false');
    $('touchBtn').setAttribute('aria-pressed', state.touchEmulation === 'always' ? 'true' : 'false');
    $('inspectBtn').setAttribute('aria-pressed', state.inspect ? 'true' : 'false');
    var shot = $('shotBtn');
    if (shot) {
      shot.title = state.framedShots === false
        ? 'Screenshot — the screen only, no device around it'
        : 'Screenshot — the whole device';
    }
    var dtBtn = $('devtoolsBtn');
    if (dtBtn) dtBtn.setAttribute('aria-pressed', dev.open ? 'true' : 'false');
    renderEditBadge();
    renderRecordBadge();
    $('chromeBtn').setAttribute('aria-pressed', state.browserChrome ? 'true' : 'false');
    $('gridBtn').setAttribute('aria-pressed', state.mode === 'grid' ? 'true' : 'false');
    // There is no API to ask whether a back or forward entry exists, and
    // history.length counts our own document too — so any disabled-state heuristic
    // would be wrong. Keep both enabled and let them no-op at the ends.
    var badge = $('urlBadge');
    badge.dataset.kind = state.proxied ? 'proxy' : 'direct';
    badge.textContent = state.proxied ? 'touch' : 'direct';
    badge.title = state.proxied
      ? 'Loaded through the local proxy: touch events, mobile User-Agent, framing unblocked'
      : 'Loaded straight into the iframe';
  }

  // ----------------------------------------------------------------- stage

  function renderStage() {
    frames.forEach(function (f) {
      if (f.root.parentNode) f.root.parentNode.removeChild(f.root);
    });
    frames = [];
    stageEl.dataset.bg = state.background;
    stageInner.dataset.mode = state.mode;

    var ids = state.mode === 'grid' ? state.gridDevices.slice() : [state.deviceId];
    if (!ids.length) ids = [state.deviceId];

    ids.forEach(function (id) {
      var dev = Catalog.byId(id);
      var api = Frame.build(dev, {
        orientation: state.orientation,
        finish: state.finish,
        statusBar: state.statusBar,
        statusBarLayout: state.statusBarLayout,
        clock: clockText(),
        browserChrome: state.browserChrome,
        showLabel: state.showLabel,
        shadow: state.shadow,
        glare: state.glare,
        url: state.realUrl,
        custom: state.custom,
        scale: 1,
      });
      wireFrame(api);
      stageInner.appendChild(api.root);
      frames.push(api);
    });

    primary = frames[0] || null;
    fitZoom();
    updateToolbar();

    var target = state.url || startPageUrl;
    frames.forEach(function (f) { setFrameSrc(f, target); });
  }

  function wireFrame(api) {
    attachLoad(api);
  }

  function attachLoad(api) {
    api.iframe.addEventListener('load', function () {
      // A frame blocked by X-Frame-Options stays on about:blank, which is
      // same-origin and therefore readable. A real cross-origin page throws.
      var blocked = false;
      try {
        blocked = api.iframe.contentWindow.location.href === 'about:blank' && !!api.pendingUrl;
      } catch (err) {
        blocked = false;
      }
      if (blocked && api === primary) offerProxy();

      // Inspect mode is a property of the panel, not of the document, so it has to
      // be re-armed every time a new page lands in the frame.
      if (state.inspect) {
        try {
          api.iframe.contentWindow.postMessage({ type: 'dp:cmd:inspect', on: true }, '*');
        } catch (e) { /* ignore */ }
      }
    });
  }

  function setFrameSrc(api, url) {
    if (!url) return;
    api.pendingUrl = url;
    api.setDesktopFallback(false);
    api.iframe.src = url;
  }

  /**
   * Millimetres behind one CSS pixel on this monitor.
   *
   * The OS reports the panel's physical size, which is per *physical* pixel; the
   * display-scaling setting lives in devicePixelRatio, so it has to be folded in.
   * EDID rounds the panel to whole centimetres, hence the calibration factor.
   */
  function mmPerCssPx() {
    if (!state.display || !state.display.mmPerPx) return 0;
    return state.display.mmPerPx * (window.devicePixelRatio || 1) * (state.calibration || 1);
  }

  /**
   * Scale at which the frame measures the same as the real device held against the
   * screen. The page inside is untouched — it still lays out at the device's own
   * logical viewport, exactly as it would on the phone.
   */
  function actualSizeScale(device) {
    var perPx = mmPerCssPx();
    if (!perPx || !device.mmPerPt) return null;
    return device.mmPerPt / perPx;
  }

  function fitZoom() {
    if (!frames.length) return;
    var padding = state.mode === 'grid' ? 26 : 48;
    var availW = stageEl.clientWidth - padding * 2;
    var availH = stageEl.clientHeight - padding * 2 - (state.showLabel ? 30 : 0);
    if (availW <= 0 || availH <= 0) return;

    frames.forEach(function (f) {
      var m = f.metrics();
      var scale;
      if (state.zoom === 'actual') {
        scale = actualSizeScale(f.device);
        if (!scale) scale = 1;
      } else if (state.zoom === 'fit') {
        if (state.mode === 'grid') {
          var perRow = Math.max(1, Math.min(frames.length, Math.floor(availW / 300)));
          var cell = (availW - (perRow - 1) * 26) / perRow;
          scale = Math.min(1, cell / m.rawW, availH / m.rawH);
        } else {
          scale = Math.min(1, availW / m.rawW, availH / m.rawH);
        }
      } else {
        scale = state.zoom;
      }
      f.setScale(Math.max(0.08, scale));
    });
  }

  // ------------------------------------------------------------ navigation

  function navigate(input, opts) {
    var raw = String(input || '').trim();
    if (!raw) return;
    if (state.realUrl && raw !== state.realUrl && !(opts && opts.noHistory)) {
      back.push(state.realUrl);
      forward = [];
    }
    vscode.postMessage({ type: 'navigate', url: raw });
  }

  /*
   * The nested frame is cross-origin, so iframe.contentWindow.history throws. Two
   * routes remain: in proxy mode the injected shim calls history.back() inside the
   * page, which is exact; otherwise fall back to the webview's own joint session
   * history, which iframe navigations are appended to.
   */
  function goBack() {
    if (state.proxied && primary) {
      try {
        primary.iframe.contentWindow.postMessage({ type: 'dp:cmd:back' }, '*');
        return;
      } catch (e) { /* fall through */ }
    }
    var prev = back.pop();
    if (prev) {
      if (state.realUrl) forward.push(state.realUrl);
      navigate(prev, { noHistory: true });
      return;
    }
    history.back();
  }

  function goForward() {
    if (state.proxied && primary) {
      try {
        primary.iframe.contentWindow.postMessage({ type: 'dp:cmd:forward' }, '*');
        return;
      } catch (e) { /* fall through */ }
    }
    var next = forward.pop();
    if (next) {
      if (state.realUrl) back.push(state.realUrl);
      navigate(next, { noHistory: true });
      return;
    }
    history.forward();
  }

  /**
   * Three strengths:
   *   normal  re-run the page, cache as-is
   *   hard    tell the proxy to revalidate everything upstream for a few seconds
   *   purge   wipe the page's storage, cookies and service workers first
   */
  function reload(mode) {
    if (mode === 'purge') {
      var frame = primary;
      if (state.proxied && frame) {
        try {
          frame.iframe.contentWindow.postMessage({ type: 'dp:cmd:purge' }, '*');
        } catch (e) { /* ignore */ }
      }
      vscode.postMessage({ type: 'purge' });
      showToast('Storage, cookies and service workers cleared. Reloading from the server…', [], 4000);
      // Give the page a beat to finish clearing before it is torn down.
      setTimeout(function () { requestHardReload(); }, 350);
      return;
    }

    if (mode === 'hard') {
      requestHardReload();
      return;
    }

    if (state.proxied && primary) {
      frames.forEach(function (f) {
        try {
          f.iframe.contentWindow.postMessage({ type: 'dp:cmd:reload' }, '*');
        } catch (e) { /* ignore */ }
      });
      return;
    }
    swapFrames();
  }

  /** The host flips the proxy into revalidate mode, then hands the URL back. */
  function requestHardReload() {
    if (state.realUrl) {
      vscode.postMessage({ type: 'hard-reload', url: state.realUrl });
      return;
    }
    swapFrames();
  }

  /** Replacing the element reloads without pushing a joint-history entry. */
  function swapFrames() {
    frames.forEach(function (f) {
      var src = f.iframe.src;
      f.recreateIframe(src);
      attachLoad(f);
      f.pendingUrl = src;
    });
  }

  function openReloadMenu(anchor) {
    openPopover(
      anchor,
      '<div class="pop-list">' +
        '<button class="pop-item" data-reload="normal">' + icon('reload') +
          '<span class="name">Reload</span><span class="meta">Ctrl+R</span></button>' +
        '<button class="pop-item" data-reload="hard">' + icon('reloadHard') +
          '<span class="name">Hard reload</span><span class="meta">Ctrl+Shift+R</span></button>' +
        '<button class="pop-item" data-reload="purge">' + icon('trash') +
          '<span class="name">Clear cache and reload</span></button>' +
        '<div class="pop-divider"></div>' +
        '<div class="pop-hint">Hard reload revalidates every request upstream. ' +
        'Clearing also wipes the page\'s storage, cookies and service workers.</div>' +
      '</div>',
      function (pop) {
        pop.addEventListener('click', function (e) {
          var item = e.target.closest ? e.target.closest('[data-reload]') : null;
          if (!item) return;
          closePopover();
          reload(item.dataset.reload);
        });
      }
    );
  }

  function loadStartPage() {
    state.url = startPageUrl;
    state.realUrl = '';
    state.proxied = false;
    frames.forEach(function (f) { setFrameSrc(f, startPageUrl); });
    $('urlInput').value = '';
    updateToolbar();
    pushStartData();
  }

  function pushStartData() {
    setTimeout(function () {
      frames.forEach(function (f) {
        try {
          f.iframe.contentWindow.postMessage(
            { type: 'dp:start:data', ports: ports, history: history, device: Catalog.byId(state.deviceId).name },
            '*'
          );
        } catch (e) { /* ignore */ }
      });
    }, 120);
  }

  function offerProxy() {
    if (state.touchEmulation === 'always') return;
    showToast(
      'This site refuses to be embedded. Load it through the local proxy?',
      [
        { label: 'Load through proxy', primary: true, action: function () {
          vscode.postMessage({ type: 'navigate', url: state.realUrl, force: 'always' });
        } },
        { label: 'Open in browser', action: function () {
          vscode.postMessage({ type: 'open-external', url: state.realUrl });
        } },
      ]
    );
  }

  // -------------------------------------------------------------- controls

  function rotate() {
    state.orientation = state.orientation === 'portrait' ? 'landscape' : 'portrait';
    persist();
    renderStage();
    vscode.postMessage({
      type: 'device-changed',
      deviceId: state.deviceId,
      deviceName: Catalog.byId(state.deviceId).name,
      orientation: state.orientation,
    });
    /*
     * Turning the device changes its screen metrics and its safe areas, and the proxy
     * substitutes both into the page — so without re-fetching, a landscape phone was
     * still being served portrait insets, portrait dimensions and a portrait
     * screen.orientation. setDevice has always done this; rotate never did.
     */
    if (state.proxied && state.realUrl) {
      vscode.postMessage({ type: 'navigate', url: state.realUrl, force: 'always' });
    }
  }

  function toggleTouch() {
    state.touchEmulation = state.touchEmulation === 'always' ? 'auto' : 'always';
    persist();
    updateToolbar();
    if (state.realUrl) {
      vscode.postMessage({ type: 'navigate', url: state.realUrl, force: state.touchEmulation });
    }
  }

  function toggleGrid() {
    state.mode = state.mode === 'grid' ? 'single' : 'grid';
    persist();
    renderStage();
  }

  function setDevice(id) {
    state.deviceId = id;
    persist();
    renderStage();
    var dev = Catalog.byId(id);
    vscode.postMessage({ type: 'device-changed', deviceId: id, deviceName: dev.name, orientation: state.orientation });
    // The proxy's User-Agent and screen metrics follow the device, so a proxied
    // page has to be re-fetched to actually see the new identity.
    if (state.proxied && state.realUrl) {
      vscode.postMessage({ type: 'navigate', url: state.realUrl, force: 'always' });
    }
  }

  function stepDevice(delta) {
    var list = Catalog.DEVICES.filter(function (d) { return d.id !== 'custom'; });
    var idx = list.findIndex(function (d) { return d.id === state.deviceId; });
    if (idx < 0) idx = 0;
    setDevice(list[(idx + delta + list.length) % list.length].id);
  }

  function setZoom(z) {
    state.zoom = z;
    persist();
    fitZoom();
    updateToolbar();
  }

  function persist() {
    vscode.postMessage({
      type: 'state',
      state: {
        deviceId: state.deviceId,
        orientation: state.orientation,
        zoom: state.zoom,
        mode: state.mode,
        custom: state.custom,
        finish: state.finish,
        statusBar: state.statusBar,
        statusBarLayout: state.statusBarLayout,
        browserChrome: state.browserChrome,
        background: state.background,
        shadow: state.shadow,
        showLabel: state.showLabel,
        glare: state.glare,
        touchEmulation: state.touchEmulation,
        gridDevices: state.gridDevices,
        calibration: state.calibration,
        framedShots: state.framedShots,
        theme: state.theme,
        devtoolsDock: dev.dock,
        devtoolsWidth: dev.width,
        devtoolsHeight: dev.height,
      },
    });
    vscode.setState(state);
  }

  /**
   * A visible marker that the page is not what the site serves.
   *
   * Live edits are replayed into every load, which is what makes them useful — and
   * exactly what makes them dangerous to leave unannounced. The badge is the honest
   * counterweight, and it is also the way back.
   */
  function recordingLabel() {
    if (!state.recording) return '';
    var s = Math.round((Date.now() - state.recording.since) / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /** A path that fits on a menu row: the last two folders, which is what identifies it. */
  function shortPath(full) {
    if (!full) return 'Desktop';
    var parts = String(full).split(/[\\/]+/).filter(Boolean);
    return parts.length <= 2 ? parts.join('\\') : '…\\' + parts.slice(-2).join('\\');
  }

  /**
   * A recording that leaves no trace on screen is one you forget you started —
   * and it keeps writing frames to disk while you do. So it announces itself, and
   * the marker is the way to stop it.
   */
  function renderRecordBadge() {
    var existing = $('recBadge');
    if (!state.recording) {
      if (existing) existing.parentNode.remove();
      if (recordTimer) {
        clearInterval(recordTimer);
        recordTimer = 0;
      }
      return;
    }

    if (!existing) {
      var group = document.createElement('div');
      group.className = 'tb-group';
      group.id = 'recBadgeGroup';
      group.innerHTML =
        '<button class="tb-btn tb-recording" id="recBadge" title="Recording — click to stop">' +
        icon('record') + '<span></span></button>';
      var toolbar = $('toolbar');
      toolbar.insertBefore(group, toolbar.lastElementChild);
      existing = $('recBadge');
      existing.addEventListener('click', function () {
        vscode.postMessage({ type: 'record-stop' });
        state.recording = null;
        updateToolbar();
        showToast('Finishing the recording — encoding takes a moment…', [], 8000);
      });
      recordTimer = setInterval(function () {
        var span = $('recBadge');
        if (span) span.querySelector('span').textContent = recordingLabel();
      }, 1000);
    }
    existing.querySelector('span').textContent = recordingLabel();
  }

  var recordTimer = 0;

  function renderEditBadge() {
    var existing = $('editBadge');
    var count = state.liveEdits || 0;

    if (!count) {
      if (existing) existing.remove();
      return;
    }

    if (!existing) {
      var group = document.createElement('div');
      group.className = 'tb-group';
      group.id = 'editBadgeGroup';
      group.innerHTML =
        '<button class="tb-btn tb-edits" id="editBadge" title="Live edits are being replayed ' +
        'on every load. Click to put the page back.">' + icon('trash') + '<span></span></button>';
      var toolbar = $('toolbar');
      toolbar.insertBefore(group, toolbar.lastElementChild);
      existing = $('editBadge');
      existing.addEventListener('click', function () {
        vscode.postMessage({ type: 'revert-edits' });
        state.liveEdits = 0;
        updateToolbar();
        showToast('Live edits reverted. Reloading the page as the site serves it.');
      });
    }
    existing.querySelector('span').textContent = count + (count === 1 ? ' edit' : ' edits');
  }

  // -------------------------------------------------------------- devtools

  /*
   * The element tree, the console and the computed styles, in a drawer under the
   * device.
   *
   * The tree is fetched a level at a time from the page: hovering a row outlines
   * the element on the phone, and clicking an element on the phone reveals its row.
   * Both directions go through the same path address, so they always agree.
   */
  var dev = {
    open: false,
    tab: 'elements',
    // Beside the device by default: a phone is tall, a monitor is wide, and the room
    // to the right of the frame is room nothing else was using.
    dock: 'right',
    width: 0,                      // px, when the owner has dragged it
    height: 0,
    children: Object.create(null), // pathKey -> array of node summaries
    expanded: Object.create(null), // pathKey -> true
    selected: null,                // path array
    root: null,
    console: [],
    filter: '',
    pending: Object.create(null),
    // Opening on a collapsed <html> shows three lines and reads as "it is broken".
    // The page is what you came to look at, so the tree unfolds to it once.
    revealedBody: false,
  };

  var pathKey = function (path) {
    return (path || []).join('.');
  };

  function toggleDevtools(tab) {
    if (tab && dev.open && dev.tab !== tab) {
      dev.tab = tab;
      renderDevtools();
      return;
    }
    dev.open = !dev.open;
    if (tab) dev.tab = tab;
    devtoolsEl.hidden = !dev.open;
    applyDock();
    updateToolbar();
    if (dev.open) {
      if (!dev.root) requestTree([]);
      renderDevtools();
      fitZoom();
    } else {
      sendToFrame({ type: 'dp:cmd:hover-path', path: null });
      fitZoom();
    }
  }

  /*
   * Ask the previewed page something and wait for its answer.
   *
   * The page is a separate document behind postMessage, so a question and its reply
   * are two unrelated events. A request id ties them together, which is what lets an
   * outside caller — the control API, and through it an AI agent — treat "find this
   * element" or "change this style" as a call that returns a value.
   *
   * Exposed on window so it can be driven from the DevTools protocol.
   */
  var askSeq = 0;
  window.__dpAsk = function (message, replyType, timeoutMs) {
    return new Promise(function (resolve) {
      if (!primary) return resolve({ error: 'No page is loaded.' });
      var rid = 'r' + (++askSeq);
      var done = false;

      var listener = function (ev) {
        var data = ev.data;
        if (!data || data.type !== replyType || data.rid !== rid) return;
        done = true;
        window.removeEventListener('message', listener);
        resolve(data);
      };
      window.addEventListener('message', listener);

      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', listener);
        resolve({ error: 'The page did not answer in time. Is it loaded through the proxy?' });
      }, timeoutMs || 6000);

      try {
        primary.iframe.contentWindow.postMessage(Object.assign({ rid: rid }, message), '*');
      } catch (e) {
        done = true;
        window.removeEventListener('message', listener);
        resolve({ error: String(e && e.message ? e.message : e) });
      }
    });
  };

  /**
   * Where a region of the device sits in this window, in window coordinates.
   *
   * Used to photograph the window that is actually on screen instead of rendering a
   * fresh copy — which is the only way a live edit shows up in a screenshot.
   *
   * The frame is drawn scaled, so a rectangle measured inside the page has to be
   * multiplied by that scale and offset by where the iframe landed.
   */
  window.__dpRegion = function (mode, selector) {
    if (!primary) return null;
    var box = function (el) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };

    if (mode === 'element') {
      if (!selector) return null;
      return window.__dpAsk({ type: 'dp:cmd:find', selector: selector, limit: 1 }, 'dp:found')
        .then(function (found) {
          if (!found || !found.matches || !found.matches.length) return null;
          var el = found.matches[0].rect;
          var frame = primary.iframe.getBoundingClientRect();
          var scale = parseFloat(primary.root.style.getPropertyValue('--scale')) || 1;
          var pad = 8 * scale;
          return {
            x: frame.left + el.x * scale - pad,
            y: frame.top + el.y * scale - pad,
            width: el.width * scale + pad * 2,
            height: el.height * scale + pad * 2,
          };
        });
    }

    var node = mode === 'screen' ? primary.root.querySelector('.dev-screen')
      : mode === 'page' ? primary.page
      : primary.root.querySelector('.dev-shell');
    return box(node);
  };

  function sendToFrame(message) {
    if (!primary) return;
    try {
      primary.iframe.contentWindow.postMessage(message, '*');
    } catch (e) { /* the frame may be mid-navigation */ }
  }

  function requestTree(path) {
    var key = pathKey(path);
    if (dev.pending[key]) return;
    dev.pending[key] = true;
    sendToFrame({ type: 'dp:cmd:tree', path: path || [] });
  }

  function onTree(msg) {
    var key = pathKey(msg.path);
    delete dev.pending[key];
    dev.children[key] = msg.children || [];
    if (msg.truncated) dev.children[key].truncated = msg.truncated;
    if (msg.root) dev.root = msg.root;

    /*
     * Unfold as far as the page itself.
     *
     * <html> with <head> and <body> shut is three lines that say nothing — it looks
     * like the tree failed to load, which is precisely how it was read. Every browser's
     * inspector opens on the body's children; so does this one, once, after which the
     * owner's own expanding and collapsing is left alone.
     */
    if (!dev.revealedBody && key === '') {
      var body = (msg.children || []).filter(function (n) { return n.tag === 'body'; })[0];
      if (body) {
        dev.revealedBody = true;
        dev.expanded[pathKey(body.path)] = true;
        requestTree(body.path);
      }
    }

    if (dev.open && dev.tab === 'elements') renderDevtools();
  }

  /** Open every ancestor of a path, then draw, so a page click reveals its row. */
  function revealPath(path) {
    if (!path) return;
    dev.selected = path;
    for (var i = 0; i < path.length; i++) {
      var ancestor = path.slice(0, i);
      dev.expanded[pathKey(ancestor)] = true;
      if (!dev.children[pathKey(ancestor)]) requestTree(ancestor);
    }
    dev.expanded[pathKey(path)] = dev.expanded[pathKey(path)] || false;
    if (dev.open && dev.tab === 'elements') {
      renderDevtools();
      var row = devtoolsEl.querySelector('.dt-row[data-path="' + pathKey(path) + '"]');
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }

  function nodeLabel(node) {
    var html = '<span class="dt-tag">&lt;' + node.tag;
    if (node.id) html += '<span class="dt-id"> id="' + Frame.escapeHtml(node.id) + '"</span>';
    if (node.classes && node.classes.length) {
      html += '<span class="dt-cls"> class="' + Frame.escapeHtml(node.classes.join(' ')) + '"</span>';
    }
    html += '&gt;</span>';
    if (node.text) html += '<span class="dt-text">' + Frame.escapeHtml(node.text) + '</span>';
    html += '<span class="dt-size">' + node.w + '×' + node.h + '</span>';
    if (node.hidden) html += '<span class="dt-flag">hidden</span>';
    return html;
  }

  function renderTreeRows(path, depth, out) {
    var key = pathKey(path);
    var kids = dev.children[key];
    if (!kids) return;
    kids.forEach(function (node) {
      var nodeKey = pathKey(node.path);
      var open = !!dev.expanded[nodeKey];
      out.push(
        '<div class="dt-row" data-path="' + nodeKey + '" ' +
          (pathKey(dev.selected) === nodeKey ? 'aria-selected="true" ' : '') +
          'style="padding-left:' + (depth * 13 + 6) + 'px">' +
          (node.kids
            ? '<button class="dt-twisty" data-toggle="' + nodeKey + '" aria-expanded="' + open + '">' +
              (open ? '▾' : '▸') + '</button>'
            : '<span class="dt-twisty"></span>') +
          nodeLabel(node) +
        '</div>'
      );
      if (open) renderTreeRows(node.path, depth + 1, out);
    });
    if (kids.truncated) {
      out.push('<div class="dt-more" style="padding-left:' + (depth * 13 + 20) + 'px">' +
        '… ' + kids.truncated + ' more siblings not shown</div>');
    }
  }

  function renderDevtools() {
    if (!dev.open) return;

    var tabs = [['elements', 'Elements'], ['console', 'Console'], ['styles', 'Styles']]
      .map(function (t) {
        return '<button class="dt-tab" data-tab="' + t[0] + '"' +
          (dev.tab === t[0] ? ' aria-selected="true"' : '') + '>' + t[1] +
          (t[0] === 'console' && dev.console.length ? '<span class="dt-count">' + dev.console.length + '</span>' : '') +
          '</button>';
      }).join('');

    var body = '';
    if (dev.tab === 'elements') {
      var rows = [];
      if (dev.root) {
        var rootOpen = dev.expanded[''] !== false;
        rows.push(
          // pathKey(null) is also "", so without the guard the root row draws itself
          // selected before anything has been picked.
          '<div class="dt-row" data-path="" ' +
            (dev.selected && pathKey(dev.selected) === '' ? 'aria-selected="true" ' : '') +
            'style="padding-left:6px">' +
            '<button class="dt-twisty" data-toggle="" aria-expanded="' + rootOpen + '">' +
              (rootOpen ? '▾' : '▸') + '</button>' +
            nodeLabel(dev.root) +
          '</div>'
        );
        if (rootOpen) renderTreeRows([], 1, rows);
      } else {
        rows.push('<div class="dt-empty">Reading the page…</div>');
      }
      body = '<div class="dt-tree" id="dtTree">' + rows.join('') + '</div>';
    } else if (dev.tab === 'console') {
      var entries = dev.console.filter(function (e) {
        return !dev.filter || (e.text || '').toLowerCase().indexOf(dev.filter) >= 0;
      });
      body =
        '<div class="dt-console" id="dtConsole">' +
        (entries.length
          ? entries.map(function (e) {
              // When it happened, because the buffer survives reloads: without a time
              // an error from the previous build reads exactly like a fresh one.
              var when = e.at ? new Date(e.at) : null;
              var clock = when
                ? String(when.getHours()).padStart(2, '0') + ':' +
                  String(when.getMinutes()).padStart(2, '0') + ':' +
                  String(when.getSeconds()).padStart(2, '0')
                : '';
              return '<div class="dt-log" data-level="' + e.level + '">' +
                (clock ? '<span class="dt-time">' + clock + '</span>' : '') +
                '<span class="dt-level">' + e.level + '</span>' +
                '<span class="dt-msg">' + Frame.escapeHtml(e.text || '') + '</span>' +
                (e.source ? '<span class="dt-src">' + Frame.escapeHtml(e.source) + '</span>' : '') +
                '</div>';
            }).join('')
          : '<div class="dt-empty">Nothing logged yet.<br>' +
            'Whatever the page prints appears here, and so does the browser\'s own account of it — ' +
            'a frame it refused to embed, a blocked dialog, a request that failed.</div>') +
        '</div>';
    } else {
      var sel = state.selection;
      if (!sel) {
        body = '<div class="dt-empty">Pick an element — click one in the tree, or turn on the ' +
          'inspector and click it on the phone.</div>';
      } else {
        var css = Object.entries(sel.styles || {}).map(function (kv) {
          return '<div class="dt-decl"><span class="dt-prop">' + Frame.escapeHtml(kv[0]) + '</span>: ' +
            '<span class="dt-val">' + Frame.escapeHtml(kv[1]) + '</span>;</div>';
        }).join('');
        body =
          '<div class="dt-styles">' +
            '<div class="dt-sel">' + Frame.escapeHtml(sel.selector || sel.name) + '</div>' +
            '<div class="dt-box">' + Math.round(sel.rect.width) + ' × ' + Math.round(sel.rect.height) +
              ' at (' + Math.round(sel.rect.x) + ', ' + Math.round(sel.rect.y) + ')</div>' +
            (css || '<div class="dt-empty">No notable computed styles.</div>') +
            '<div class="dt-markup"><b>Markup</b><pre>' + Frame.escapeHtml(sel.html || '') + '</pre></div>' +
          '</div>';
      }
    }

    devtoolsEl.innerHTML =
      '<div class="dt-head">' +
        '<div class="dt-tabs">' + tabs + '</div>' +
        (dev.tab === 'console'
          ? '<input class="dt-filter" id="dtFilter" placeholder="Filter…" value="' +
            Frame.escapeHtml(dev.filter) + '">' +
            '<button class="dt-act" id="dtClear" title="Clear">' + icon('trash') + '</button>'
          : '') +
        (dev.tab === 'elements'
          ? '<button class="dt-act" id="dtRefresh" title="Re-read the page">' + icon('reload') + '</button>'
          : '') +
        '<button class="dt-act" id="dtDock" title="' +
          (dev.dock === 'right' ? 'Move under the device' : 'Move beside the device') + '">' +
          icon(dev.dock === 'right' ? 'dockBottom' : 'dockRight') + '</button>' +
        '<button class="dt-act" id="dtClose" title="Close">' + icon('close') + '</button>' +
      '</div>' +
      '<div class="dt-body">' + body + '</div>' +
      '<div class="dt-grip" id="dtGrip" title="Drag to resize"></div>';

    wireDevtools();
  }

  /**
   * Light or dark, or whatever Windows is set to.
   *
   * Only meaningful in the standalone window: the extension inherits the editor's
   * theme through the same variables, and a switch of our own would fight it.
   */
  function applyTheme(theme) {
    state.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (!window.__DP_STANDALONE__) return;
    var wanted = state.theme;
    if (wanted === 'system') {
      wanted = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = wanted;
  }

  if (window.matchMedia) {
    var systemTheme = window.matchMedia('(prefers-color-scheme: light)');
    var onSystemTheme = function () { if ((state.theme || 'system') === 'system') applyTheme('system'); };
    if (systemTheme.addEventListener) systemTheme.addEventListener('change', onSystemTheme);
    else if (systemTheme.addListener) systemTheme.addListener(onSystemTheme);
  }

  /** Where the drawer sits, and how much room it takes. */
  function applyDock() {
    appEl.dataset.dock = dev.dock;
    appEl.dataset.dt = dev.open ? 'open' : 'closed';
    if (dev.width) appEl.style.setProperty('--dt-w', dev.width + 'px');
    if (dev.height) appEl.style.setProperty('--dt-h', dev.height + 'px');
  }

  function setDock(dock) {
    dev.dock = dock === 'bottom' ? 'bottom' : 'right';
    applyDock();
    renderDevtools();
    fitZoom();
    persist();
  }

  /*
   * Dragging the drawer's edge.
   *
   * Pointer capture rather than listeners on the document: the pointer crosses the
   * iframe on its way, and a frame from another origin swallows events that were
   * never captured — the drawer would stick to the cursor and never let go.
   */
  function wireGrip() {
    var grip = $('dtGrip');
    if (!grip) return;
    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.dataset.dragging = 'true';

      var rect = appEl.getBoundingClientRect();
      var move = function (ev) {
        if (dev.dock === 'right') {
          var w = Math.round(rect.right - ev.clientX);
          dev.width = Math.max(260, Math.min(Math.round(rect.width - 260), w));
        } else {
          var h = Math.round(rect.bottom - ev.clientY);
          dev.height = Math.max(140, Math.min(Math.round(rect.height - 160), h));
        }
        applyDock();
      };
      var up = function () {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        delete grip.dataset.dragging;
        fitZoom();
        persist();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  function wireDevtools() {
    devtoolsEl.querySelectorAll('.dt-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        dev.tab = tab.dataset.tab;
        renderDevtools();
      });
    });

    on('dtClose', 'click', function () { toggleDevtools(); });
    on('dtDock', 'click', function () { setDock(dev.dock === 'right' ? 'bottom' : 'right'); });
    on('dtClear', 'click', function () {
      dev.console = [];
      renderDevtools();
    });
    wireGrip();
    on('dtRefresh', 'click', function () {
      dev.children = Object.create(null);
      dev.root = null;
      requestTree([]);
    });

    var filter = $('dtFilter');
    if (filter) {
      filter.addEventListener('input', function () {
        dev.filter = filter.value.trim().toLowerCase();
        var box = $('dtConsole');
        if (box) renderDevtools();
      });
    }

    var tree = $('dtTree');
    if (!tree) return;

    tree.addEventListener('click', function (e) {
      var twisty = e.target.closest ? e.target.closest('[data-toggle]') : null;
      if (twisty) {
        var key = twisty.dataset.toggle;
        var path = key === '' ? [] : key.split('.').map(Number);
        dev.expanded[key] = key === '' ? dev.expanded[key] === false : !dev.expanded[key];
        if (dev.expanded[key] && !dev.children[key]) requestTree(path);
        else renderDevtools();
        return;
      }
      var row = e.target.closest ? e.target.closest('.dt-row') : null;
      if (!row) return;
      var p = row.dataset.path === '' ? [] : row.dataset.path.split('.').map(Number);
      dev.selected = p;
      sendToFrame({ type: 'dp:cmd:select-path', path: p });
      renderDevtools();
    });

    // Hovering a row is what lights the element up on the phone.
    tree.addEventListener('mouseover', function (e) {
      var row = e.target.closest ? e.target.closest('.dt-row') : null;
      if (!row) return;
      var p = row.dataset.path === '' ? [] : row.dataset.path.split('.').map(Number);
      sendToFrame({ type: 'dp:cmd:hover-path', path: p });
    });
    tree.addEventListener('mouseleave', function () {
      sendToFrame({ type: 'dp:cmd:hover-path', path: null });
    });
  }

  // ------------------------------------------------- inspector and capture

  function toggleInspect() {
    state.inspect = !state.inspect;
    updateToolbar();
    frames.forEach(function (f) {
      try {
        f.iframe.contentWindow.postMessage({ type: 'dp:cmd:inspect', on: state.inspect }, '*');
      } catch (e) { /* ignore */ }
    });
    if (!state.inspect) return;
    if (!state.proxied) {
      showToast(
        'The inspector needs the page loaded through the proxy. Turn on touch mode to use it.',
        [{ label: 'Turn on touch mode', primary: true, action: function () {
          state.touchEmulation = 'always';
          persist();
          if (state.realUrl) vscode.postMessage({ type: 'navigate', url: state.realUrl, force: 'always' });
        } }]
      );
    }
  }

  function clearSelection() {
    state.selection = null;
    renderSelection();
    frames.forEach(function (f) {
      try {
        f.iframe.contentWindow.postMessage({ type: 'dp:cmd:clear-selection' }, '*');
      } catch (e) { /* ignore */ }
    });
  }

  function renderSelection() {
    var sel = state.selection;
    if (!sel) {
      selectionEl.hidden = true;
      selectionEl.innerHTML = '';
      return;
    }
    selectionEl.hidden = false;
    selectionEl.innerHTML =
      '<div class="sel-what">' +
        '<b>' + Frame.escapeHtml(sel.name) + '</b>' +
        '<span class="sel-size">' + Math.round(sel.rect.width) + ' × ' + Math.round(sel.rect.height) + '</span>' +
        (sel.ancestors && sel.ancestors.length
          ? '<span class="sel-path">' + Frame.escapeHtml(sel.ancestors.join(' › ')) + '</span>' : '') +
      '</div>' +
      '<div class="sel-actions">' +
        '<button class="sel-btn primary" id="selForAI">' + icon('copy') + 'Copy for AI</button>' +
        '<button class="sel-btn" id="selImage">' + icon('camera') + 'Copy image</button>' +
        '<button class="sel-btn" id="selHtml">' + icon('copy') + 'HTML</button>' +
        '<button class="sel-btn" id="selSelector">' + icon('copy') + 'Selector</button>' +
        '<button class="sel-btn ghost" id="selClear">' + icon('close') + '</button>' +
      '</div>';

    on('selForAI', 'click', function () {
      vscode.postMessage({
        type: 'element-for-ai',
        element: state.selection,
        device: describeDevice(),
      });
    });
    on('selImage', 'click', function () {
      capture('element', { selector: state.selection.selector, toClipboard: true });
    });
    on('selHtml', 'click', function () {
      vscode.postMessage({ type: 'copy', text: state.selection.html });
    });
    on('selSelector', 'click', function () {
      vscode.postMessage({ type: 'copy', text: state.selection.selector });
    });
    on('selClear', 'click', clearSelection);
  }

  function describeDevice() {
    var dev = Catalog.byId(state.deviceId);
    var o = Catalog.oriented(dev, state.orientation, state.custom);
    return { id: dev.id, name: dev.name, width: o.w, height: o.h, dpr: o.dpr, orientation: state.orientation };
  }

  function capture(mode, extra) {
    if (!state.realUrl && mode !== 'frame') {
      showToast('Load a page first — there is nothing to capture yet.');
      return;
    }
    showToast('Capturing…', [], 2500);
    vscode.postMessage(Object.assign({
      type: 'capture',
      mode: mode,
      url: state.realUrl,
      device: state.deviceId,
      orientation: state.orientation,
      finish: state.finish,
      statusBar: state.statusBar,
      statusBarLayout: state.statusBarLayout,
      clock: clockText(),
      browserChrome: state.browserChrome,
      background: state.background,
      custom: state.custom,
      toClipboard: true,
    }, extra || {}));
  }

  function openCameraMenu(anchor) {
    var sel = state.selection;
    openPopover(
      anchor,
      '<div class="pop-list">' +
        '<div class="pop-group">Screenshot</div>' +
        '<button class="pop-item" data-shot="frame">' + icon('device') + '<span class="name">Whole device</span></button>' +
        '<button class="pop-item" data-shot="screen">' + icon('device') + '<span class="name">Screen only</span></button>' +
        '<button class="pop-item" data-shot="page">' + icon('chrome') + '<span class="name">Page area</span></button>' +
        '<button class="pop-item" data-shot="full">' + icon('chrome') + '<span class="name">Full page, scrolled</span></button>' +
        (sel
          ? '<button class="pop-item" data-shot="element">' + icon('inspect') +
            '<span class="name">Selected element</span><span class="meta">' + Frame.escapeHtml(sel.name) + '</span></button>'
          : '') +
        '<div class="pop-divider"></div>' +
        '<div class="pop-group">Recording</div>' +
        (state.recording
          ? '<button class="pop-item" id="recStop">' + icon('record') +
            '<span class="name">Stop recording</span><span class="meta">' + recordingLabel() + '</span></button>'
          : '<button class="pop-item" id="recStart">' + icon('record') +
            '<span class="name">Start recording</span><span class="meta">no limit</span></button>') +
        '<button class="pop-item" data-record="5">' + icon('record') + '<span class="name">Record 5 seconds</span></button>' +
        '<button class="pop-item" data-record="10">' + icon('record') + '<span class="name">Record 10 seconds</span></button>' +
        '<div class="pop-divider"></div>' +
        '<div class="pop-group">Everything at once</div>' +
        '<button class="pop-item" id="collectBtn">' + icon('copy') +
          '<span class="name">Save everything about this page</span></button>' +
        '<button class="pop-item" id="openFolderBtn">' + icon('external') +
          '<span class="name">Open the folder for this site</span></button>' +
        '<button class="pop-item" id="rootBtn">' + icon('folder') +
          '<span class="name">Change where this is saved…</span>' +
          '<span class="meta">' + Frame.escapeHtml(shortPath(state.libraryRoot)) + '</span></button>' +
        '<div class="pop-divider"></div>' +
        // What the camera button does when you just press it. Two shapes cover almost
        // everything: the device as an object, or the software on its own.
        toggleRow('framedChk', 'Include the device frame', state.framedShots !== false) +
        '<div class="pop-divider"></div>' +
        '<div class="pop-hint">Captures are filed by site under ' +
        '<b>' + Frame.escapeHtml(state.libraryRoot || 'Desktop → Custom AI View') + '</b>. ' +
        '“Save everything” puts a screenshot, the markup, the console and the selected ' +
        'element into one dated folder.</div>' +
      '</div>',
      function (pop) {
        on('recStart', 'click', function () {
          closePopover();
          vscode.postMessage({ type: 'record-start', fps: 10 });
          state.recording = { since: Date.now() };
          updateToolbar();
          showToast('Recording. Stop it from the camera menu, or with the red button.', [], 6000);
        });
        on('recStop', 'click', function () {
          closePopover();
          vscode.postMessage({ type: 'record-stop' });
          state.recording = null;
          updateToolbar();
          showToast('Finishing the recording — encoding takes a moment…', [], 8000);
        });
        on('collectBtn', 'click', function () {
          closePopover();
          vscode.postMessage({ type: 'collect' });
          showToast('Collecting everything about this page…', [], 5000);
        });
        on('openFolderBtn', 'click', function () {
          closePopover();
          vscode.postMessage({ type: 'open-site-folder' });
        });
        on('rootBtn', 'click', function () {
          closePopover();
          vscode.postMessage({ type: 'choose-library-root' });
        });
        bindCheck('framedChk', function (v) {
          state.framedShots = v;
          persist();
          updateToolbar();
        });

        pop.addEventListener('click', function (e) {
          var shot = e.target.closest ? e.target.closest('[data-shot]') : null;
          var rec = e.target.closest ? e.target.closest('[data-record]') : null;
          if (shot) {
            closePopover();
            capture(shot.dataset.shot, shot.dataset.shot === 'element' && sel ? { selector: sel.selector } : {});
          } else if (rec) {
            closePopover();
            showToast('Recording ' + rec.dataset.record + ' seconds…', [], parseInt(rec.dataset.record, 10) * 1000 + 2000);
            vscode.postMessage({
              type: 'record',
              durationMs: parseInt(rec.dataset.record, 10) * 1000,
              fps: 10,
              url: state.realUrl,
              device: state.deviceId,
              orientation: state.orientation,
              finish: state.finish,
              statusBar: state.statusBar,
              statusBarLayout: state.statusBarLayout,
              clock: clockText(),
              browserChrome: state.browserChrome,
              background: state.background,
              custom: state.custom,
            });
          }
        });
      }
    );
  }

  // -------------------------------------------------------------- popovers

  function openPopover(anchor, html, wire) {
    closePopover();
    popoverEl.innerHTML = html;
    popoverEl.hidden = false;
    var rect = anchor.getBoundingClientRect();
    popoverEl.style.visibility = 'hidden';
    requestAnimationFrame(function () {
      var pw = popoverEl.offsetWidth;
      var left = Math.min(Math.max(8, rect.left), window.innerWidth - pw - 8);
      popoverEl.style.left = left + 'px';
      popoverEl.style.top = rect.bottom + 6 + 'px';
      popoverEl.style.visibility = 'visible';
    });
    if (wire) wire(popoverEl);
    setTimeout(function () {
      document.addEventListener('mousedown', outsideClose, true);
      document.addEventListener('keydown', escClose, true);
    }, 0);
  }

  function closePopover() {
    popoverEl.hidden = true;
    popoverEl.innerHTML = '';
    document.removeEventListener('mousedown', outsideClose, true);
    document.removeEventListener('keydown', escClose, true);
  }

  function outsideClose(e) {
    if (!popoverEl.contains(e.target)) closePopover();
  }

  function escClose(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  }

  /*
   * Device carousel.
   *
   * A list of sixty devices is a wall of text; the thing you actually recognise is
   * the shape. So each device is a silhouette drawn to its real aspect ratio with
   * its real cutout, laid out in a strip you can flick through.
   */
  function openDeviceCarousel() {
    var groups = Catalog.groups();
    var activeGroup = groupOf(state.deviceId, groups);

    carouselEl.hidden = false;
    carouselEl.innerHTML =
      '<div class="car-head">' +
        '<input class="car-search" id="carSearch" type="text" spellcheck="false" ' +
          'autocomplete="off" placeholder="Search device or size…">' +
        '<div class="car-tabs" id="carTabs">' +
          groups.map(function (g) {
            return '<button class="car-tab" data-group="' + Frame.escapeHtml(g.name) + '"' +
              (g.name === activeGroup ? ' aria-selected="true"' : '') + '>' +
              Frame.escapeHtml(g.name) + '</button>';
          }).join('') +
        '</div>' +
        '<button class="car-close" id="carClose" aria-label="Close">' + icon('close') + '</button>' +
      '</div>' +
      '<div class="car-body">' +
        '<button class="car-nav" id="carPrev" aria-label="Scroll left">' + icon('back') + '</button>' +
        '<div class="car-track" id="carTrack"></div>' +
        '<button class="car-nav" id="carNext" aria-label="Scroll right">' + icon('forward') + '</button>' +
      '</div>';

    var track = $('carTrack');
    var search = $('carSearch');
    var query = '';

    function matches(d) {
      if (!query) return true;
      var hay = (d.name + ' ' + d.brand + ' ' + d.id + ' ' + d.w + 'x' + d.h + ' ' + d.w + ' ' + d.h).toLowerCase();
      return hay.indexOf(query) >= 0;
    }

    function paint() {
      var cards = [];
      groups.forEach(function (g) {
        var items = g.items.filter(matches);
        if (!items.length) return;
        if (!query) cards.push('<div class="car-label" data-group="' + Frame.escapeHtml(g.name) + '">' +
          Frame.escapeHtml(g.name) + '</div>');
        items.forEach(function (d) {
          cards.push(cardHtml(d));
        });
      });
      track.innerHTML = cards.length
        ? cards.join('')
        : '<div class="car-empty">Nothing matched “' + Frame.escapeHtml(query) + '”</div>';
      var active = track.querySelector('.car-card[aria-selected="true"]');
      if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    function cardHtml(d) {
      // Aspect ratio drives the silhouette, so a Pro Max reads as taller than a mini.
      var tall = 84;
      var w = Math.round(tall * (d.w / d.h));
      return (
        '<button class="car-card" data-id="' + d.id + '"' +
          (d.id === state.deviceId ? ' aria-selected="true"' : '') + '>' +
          '<span class="car-shape" data-cutout="' + d.cutout + '" data-kind="' + d.kind + '" ' +
            'style="width:' + w + 'px;height:' + tall + 'px;--sr:' + Math.max(2, Math.round(d.radius / 6)) + 'px"></span>' +
          '<b>' + Frame.escapeHtml(d.name) + '</b>' +
          '<span class="car-size">' + d.w + ' × ' + d.h + '</span>' +
          '<span class="car-dpr">@' + d.dpr + 'x</span>' +
        '</button>'
      );
    }

    paint();

    search.addEventListener('input', function () {
      query = search.value.trim().toLowerCase();
      paint();
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = track.querySelector('.car-card');
        if (first) pick(first.dataset.id);
      } else if (e.key === 'Escape') {
        closeCarousel();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        step(e.key === 'ArrowRight' ? 1 : -1);
      }
    });

    track.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.car-card') : null;
      if (card) pick(card.dataset.id);
    });

    // A vertical wheel over a horizontal strip should move it sideways.
    track.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      track.scrollLeft += e.deltaY;
    }, { passive: false });

    $('carPrev').addEventListener('click', function () { nudge(-1); });
    $('carNext').addEventListener('click', function () { nudge(1); });
    $('carClose').addEventListener('click', closeCarousel);

    $('carTabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.car-tab') : null;
      if (!tab) return;
      search.value = '';
      query = '';
      paint();
      var label = track.querySelector('.car-label[data-group="' + tab.dataset.group + '"]');
      if (label) label.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
      [].forEach.call($('carTabs').children, function (t) {
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
    });

    function nudge(dir) {
      track.scrollBy({ left: dir * Math.max(240, track.clientWidth * 0.7), behavior: 'smooth' });
    }

    function step(dir) {
      var cards = [].slice.call(track.querySelectorAll('.car-card'));
      var idx = cards.findIndex(function (c) { return c.getAttribute('aria-selected') === 'true'; });
      var next = cards[Math.max(0, Math.min(cards.length - 1, (idx < 0 ? 0 : idx) + dir))];
      if (!next) return;
      cards.forEach(function (c) { c.setAttribute('aria-selected', c === next ? 'true' : 'false'); });
      next.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }

    function pick(id) {
      if (id === 'custom') {
        closeCarousel();
        openCustomSize($('deviceBtn'));
        return;
      }
      setDevice(id);
      closeCarousel();
    }

    search.focus();
    document.addEventListener('keydown', carouselEsc, true);
  }

  function groupOf(deviceId, groups) {
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) {
        if (groups[i].items[j].id === deviceId) return groups[i].name;
      }
    }
    return groups[0] ? groups[0].name : '';
  }

  function carouselEsc(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closeCarousel();
  }

  function closeCarousel() {
    carouselEl.hidden = true;
    carouselEl.innerHTML = '';
    document.removeEventListener('keydown', carouselEsc, true);
  }

  function openDevicePicker(anchor) {
    var groups = Catalog.groups();
    var html =
      '<div class="pop-search"><input id="devSearch" type="text" placeholder="Search device or size…" ' +
      'spellcheck="false" autocomplete="off"></div><div class="pop-list" id="devList"></div>';

    openPopover(anchor, html, function () {
      var list = $('devList');
      var search = $('devSearch');

      function paint(query) {
        var q = String(query || '').trim().toLowerCase();
        var out = '';
        groups.forEach(function (g) {
          var items = g.items.filter(function (d) {
            if (!q) return true;
            return (
              (d.name + ' ' + d.brand + ' ' + d.id + ' ' + d.w + ' ' + d.h + ' ' + d.w + 'x' + d.h)
                .toLowerCase()
                .indexOf(q) >= 0
            );
          });
          if (!items.length) return;
          out += '<div class="pop-group">' + Frame.escapeHtml(g.name) + '</div>';
          items.forEach(function (d) {
            out +=
              '<button class="pop-item" data-id="' + d.id + '" aria-selected="' +
              (d.id === state.deviceId) + '">' +
              '<span class="name">' + Frame.escapeHtml(d.name) + '</span>' +
              '<span class="meta">' + d.w + '×' + d.h + '</span></button>';
          });
        });
        list.innerHTML = out || '<div class="pop-group">Nothing matched</div>';
      }

      paint('');
      search.focus();
      search.addEventListener('input', function () { paint(search.value); });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var first = list.querySelector('.pop-item');
          if (first) {
            setDevice(first.dataset.id);
            closePopover();
          }
        }
      });
      list.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.pop-item') : null;
        if (!item) return;
        if (item.dataset.id === 'custom') {
          closePopover();
          openCustomSize(anchor);
          return;
        }
        setDevice(item.dataset.id);
        closePopover();
      });
    });
  }

  function openCustomSize(anchor) {
    openPopover(
      anchor,
      '<div class="pop-group">Custom viewport</div>' +
        '<div class="pop-row"><label>Width</label><input type="number" id="cw" min="120" max="4096" value="' + state.custom.w + '"></div>' +
        '<div class="pop-row"><label>Height</label><input type="number" id="ch" min="120" max="4096" value="' + state.custom.h + '"></div>' +
        '<div class="pop-row"><label>Pixel ratio</label><input type="number" id="cd" min="1" max="4" step="0.5" value="' + state.custom.dpr + '"></div>' +
        '<div class="pop-divider"></div>' +
        '<div class="pop-row"><button class="pop-item" id="applyCustom" style="justify-content:center;background:var(--vscode-button-background);color:var(--vscode-button-foreground)">Apply</button></div>',
      function () {
        $('applyCustom').addEventListener('click', function () {
          state.custom = {
            w: clamp(parseInt($('cw').value, 10) || 400, 120, 4096),
            h: clamp(parseInt($('ch').value, 10) || 800, 120, 4096),
            dpr: clamp(parseFloat($('cd').value) || 2, 1, 4),
          };
          setDevice('custom');
          closePopover();
        });
      }
    );
  }

  function openZoomMenu(anchor) {
    var dev = Catalog.oriented(Catalog.byId(state.deviceId), state.orientation, state.custom);
    var actual = actualSizeScale(dev);
    var perPx = mmPerCssPx();

    var levels = [
      ['fit', 'Fit to panel', ''],
      ['actual', 'Actual size 1:1', actual ? Math.round(actual * 100) + '%' : 'unavailable'],
      [0.25, '25%', ''], [0.5, '50%', ''], [0.75, '75%', ''], [1, '100%', ''],
      [1.25, '125%', ''], [1.5, '150%', ''], [2, '200%', ''],
    ];

    var physical = actual
      ? '<div class="pop-hint">At 1:1 this device measures <b>' +
        (dev.w * dev.mmPerPt).toFixed(0) + ' × ' + (dev.h * dev.mmPerPt).toFixed(0) +
        ' mm</b> of screen, the same as the real one. The page inside still lays out at ' +
        dev.w + ' × ' + dev.h + ' points, exactly as it does on the phone.<br>' +
        'Your display: ' + (state.display ? state.display.dpi + ' dpi' : 'unknown') +
        ' · ' + (perPx ? (1 / perPx).toFixed(2) : '?') + ' px per mm.</div>' +
        '<button class="pop-item" id="calibrateBtn"><span class="name">Calibrate with a bank card…</span></button>'
      : '<div class="pop-hint">The physical size of your monitor could not be read, so 1:1 is ' +
        'unavailable. Calibrating with a bank card sets it by hand.</div>' +
        '<button class="pop-item" id="calibrateBtn"><span class="name">Calibrate with a bank card…</span></button>';

    var html = '<div class="pop-list">' + levels.map(function (l) {
      var active = String(state.zoom) === String(l[0]);
      return '<button class="pop-item" data-zoom="' + l[0] + '" aria-selected="' + active + '">' +
        '<span class="name">' + l[1] + '</span>' +
        (l[2] ? '<span class="meta">' + l[2] + '</span>' : '') +
        (active ? icon('check') : '') + '</button>';
    }).join('') + '<div class="pop-divider"></div>' + physical + '</div>';

    openPopover(anchor, html, function (pop) {
      pop.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('#calibrateBtn')) {
          closePopover();
          openCalibration(anchor);
          return;
        }
        var item = e.target.closest ? e.target.closest('[data-zoom]') : null;
        if (!item) return;
        var v = item.dataset.zoom;
        setZoom(v === 'fit' || v === 'actual' ? v : parseFloat(v));
        closePopover();
      });
    });
  }

  /*
   * Calibration.
   *
   * EDID rounds the panel size to whole centimetres, which is about 1.5% out, and
   * some monitors report nothing at all. A bank card is the one object everyone has
   * whose size is fixed by standard — ISO/IEC 7810 ID-1, 85.60 mm wide — so matching
   * a drawn rectangle to it pins the scale exactly.
   */
  function openCalibration(anchor) {
    var CARD_MM = 85.6;
    var base = state.display && state.display.mmPerPx
      ? state.display.mmPerPx * (window.devicePixelRatio || 1)
      : 0.25;
    var factor = state.calibration || 1;

    function widthPx() {
      return CARD_MM / (base * factor);
    }

    openPopover(
      anchor,
      '<div class="pop-group">Hold a bank card against the screen</div>' +
      '<div class="cal-wrap">' +
        '<div class="cal-card" id="calCard"><span>85.6 mm</span></div>' +
      '</div>' +
      '<div class="pop-hint">Drag the slider until the rectangle is exactly as wide as the card. ' +
        'Any bank card will do — they are all the same size by standard.</div>' +
      '<div class="pop-row"><input type="range" id="calRange" min="70" max="140" step="0.25" ' +
        'value="' + (factor * 100).toFixed(2) + '" style="flex:1"></div>' +
      '<div class="pop-row"><label>Result</label><span id="calResult" class="meta"></span></div>' +
      '<div class="pop-divider"></div>' +
      '<div class="pop-row" style="gap:6px">' +
        '<button class="pop-item" id="calReset" style="justify-content:center">Reset</button>' +
        '<button class="pop-item" id="calApply" style="justify-content:center;' +
          'background:var(--vscode-button-background);color:var(--vscode-button-foreground)">Apply</button>' +
      '</div>',
      function () {
        var card = $('calCard');
        var range = $('calRange');
        var result = $('calResult');

        function paint() {
          factor = parseFloat(range.value) / 100;
          card.style.width = widthPx() + 'px';
          card.style.height = (widthPx() * 53.98) / CARD_MM + 'px';
          var dpi = 25.4 / (base * factor);
          result.textContent = dpi.toFixed(0) + ' dpi · ' + (1 / (base * factor)).toFixed(2) + ' px per mm';
        }

        paint();
        range.addEventListener('input', paint);
        $('calReset').addEventListener('click', function () {
          range.value = '100';
          paint();
        });
        $('calApply').addEventListener('click', function () {
          state.calibration = factor;
          persist();
          setZoom('actual');
          closePopover();
          showToast('Calibrated: ' + (25.4 / (base * factor)).toFixed(0) + ' dpi. 1:1 is now exact.');
        });
      }
    );
  }

  function openAppearanceMenu(anchor) {
    var dev = Catalog.byId(state.deviceId);
    var swatch = { graphite: '#55585f', black: '#232427', silver: '#cfd3d8', gold: '#d9c39d', desert: '#c6ab92', blue: '#46586e' };
    var finishes = dev.finishes.map(function (f) {
      return '<button class="pop-item" data-finish="' + f + '" aria-selected="' + (state.finish === f) + '">' +
        '<span class="swatch" style="background:' + swatch[f] + '"></span><span class="name">' +
        f.charAt(0).toUpperCase() + f.slice(1) + '</span></button>';
    }).join('');

    openPopover(
      anchor,
      // Only the standalone window owns its palette. Inside the editor the theme is
      // the editor's, and a second switch that fought it would just look broken.
      (window.__DP_STANDALONE__
        ? '<div class="pop-row"><label for="themeMode">Theme</label>' +
          select('themeMode', [['system', 'Follow Windows'], ['dark', 'Dark'], ['light', 'Light']],
            state.theme || 'system') + '</div>' +
          '<div class="pop-divider"></div>'
        : '') +
      '<div class="pop-group">Finish</div>' + finishes +
      '<div class="pop-divider"></div>' +
      '<div class="pop-row"><label for="sbStyle">Status bar</label>' +
        select('sbStyle', [['auto', 'Follow the page'], ['dark', 'Dark glyphs'], ['light', 'Light glyphs'], ['hidden', 'Hidden']], state.statusBar) + '</div>' +
      '<div class="pop-row"><label for="sbLayout">Page starts</label>' +
        select('sbLayout', [['inset', 'Below status bar'], ['overlay', 'Edge to edge']], state.statusBarLayout) + '</div>' +
      '<div class="pop-row"><label for="clockMode">Clock</label>' +
        select('clockMode', [['real', 'Live time'], ['apple', '9:41'], ['custom', 'Custom']], state.clock) + '</div>' +
      '<div class="pop-row"><label for="pointerMode">Pointer</label>' +
        select('pointerMode', [['auto', 'Finger on phones'], ['finger', 'Always finger'],
          ['dot', 'Small dot'], ['arrow', 'System arrow']], state.pointerStyle || 'auto') + '</div>' +
      '<div class="pop-row"><label for="bgMode">Backdrop</label>' +
        select('bgMode', [['studio', 'Studio'], ['dark', 'Dark'], ['light', 'Light'], ['grid', 'Grid'], ['editor', 'Editor']], state.background) + '</div>' +
      '<div class="pop-divider"></div>' +
      toggleRow('shadowChk', 'Drop shadow', state.shadow) +
      toggleRow('glareChk', 'Glass sheen', state.glare) +
      toggleRow('labelChk', 'Size label', state.showLabel),
      function (pop) {
        pop.addEventListener('click', function (e) {
          var item = e.target.closest ? e.target.closest('[data-finish]') : null;
          if (!item) return;
          state.finish = item.dataset.finish;
          persist();
          renderStage();
          closePopover();
        });
        bindSelect('themeMode', function (v) { applyTheme(v); persist(); });
        bindSelect('sbStyle', function (v) { state.statusBar = v; renderStage(); });
        bindSelect('sbLayout', function (v) { state.statusBarLayout = v; renderStage(); });
        bindSelect('clockMode', function (v) { state.clock = v; renderStage(); });
        bindSelect('pointerMode', function (v) {
          state.pointerStyle = v;
          // Applied live, so the choice can be judged by moving the mouse.
          sendToFrame({ type: 'dp:cmd:pointer', mode: Catalog.pointerFor(v, Catalog.byId(state.deviceId)) });
        });
        bindSelect('bgMode', function (v) { state.background = v; stageEl.dataset.bg = v; persist(); });
        bindCheck('shadowChk', function (v) { state.shadow = v; renderStage(); });
        bindCheck('glareChk', function (v) { state.glare = v; renderStage(); });
        bindCheck('labelChk', function (v) { state.showLabel = v; renderStage(); });
      }
    );
  }

  function openMoreMenu(anchor) {
    var wall = Catalog.DEVICES.filter(function (d) { return d.id !== 'custom'; });
    openPopover(
      anchor,
      '<div class="pop-list">' +
        item('openExternal', 'external', 'Open in browser') +
        item('copyUrl', 'external', 'Copy URL') +
        item('scanPorts', 'server', 'Scan local dev servers') +
        '<div class="pop-divider"></div>' +
        // With more than one build on disk and no version anywhere, "which one am I
        // looking at" had no answer. The log lives beside it, for when it matters —
        // and so does whose product this is, which is the point of a notice: it
        // travels with every copy.
        '<div class="pop-hint">' +
          '<b>Custom AI View</b> ' + Frame.escapeHtml(state.version || '') +
          '<br>© 2026 Custom AI · <span class="pop-link" id="aboutLink">ccustom.ai/view</span>' +
          (state.logFile ? '<br>Log: ' + Frame.escapeHtml(state.logFile) : '') +
        '</div>' +
        '<div class="pop-divider"></div>' +
        '<div class="pop-group">Wall devices</div>' +
        wall.slice(0, 60).map(function (d) {
          var on = state.gridDevices.indexOf(d.id) >= 0;
          return '<button class="pop-item" data-wall="' + d.id + '" aria-selected="' + on + '">' +
            '<span class="name">' + Frame.escapeHtml(d.name) + '</span>' + (on ? icon('check') : '') + '</button>';
        }).join('') +
      '</div>',
      function (pop) {
        pop.addEventListener('click', function (e) {
          var target = e.target.closest ? e.target.closest('[id],[data-wall]') : null;
          if (!target) return;
          if (target === pop) return;
          if (target.dataset.wall) {
            var id = target.dataset.wall;
            var idx = state.gridDevices.indexOf(id);
            if (idx >= 0) state.gridDevices.splice(idx, 1);
            else state.gridDevices.push(id);
            persist();
            if (state.mode === 'grid') renderStage();
            openMoreMenu(anchor);
            return;
          }
          if (target.id === 'openExternal' && state.realUrl) {
            vscode.postMessage({ type: 'open-external', url: state.realUrl });
          } else if (target.id === 'copyUrl' && state.realUrl) {
            vscode.postMessage({ type: 'copy', text: state.realUrl });
          } else if (target.id === 'scanPorts') {
            vscode.postMessage({ type: 'scan-ports' });
          } else if (target.id === 'aboutLink') {
            vscode.postMessage({ type: 'open-external', url: 'https://ccustom.ai/view' });
          }
          closePopover();
        });
      }
    );
  }

  function item(id, ic, label) {
    return '<button class="pop-item" id="' + id + '">' + icon(ic) + '<span class="name">' + label + '</span></button>';
  }

  function select(id, options, value) {
    return '<select id="' + id + '">' + options.map(function (o) {
      return '<option value="' + o[0] + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>';
  }

  function toggleRow(id, label, checked) {
    return '<div class="pop-row"><label for="' + id + '">' + label + '</label>' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '></div>';
  }

  function bindSelect(id, fn) {
    var node = $(id);
    if (node) node.addEventListener('change', function () { fn(node.value); persist(); });
  }

  function bindCheck(id, fn) {
    var node = $(id);
    if (node) node.addEventListener('change', function () { fn(node.checked); persist(); });
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ----------------------------------------------------------------- toast

  var toastTimer = 0;

  function showToast(message, actions, timeout) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = '<span>' + Frame.escapeHtml(message) + '</span>';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.textContent = a.label;
      if (!a.primary) b.className = 'ghost';
      b.addEventListener('click', function () {
        hideToast();
        if (a.action) a.action();
      });
      toastEl.appendChild(b);
    });
    var close = document.createElement('button');
    close.className = 'ghost';
    close.textContent = 'Dismiss';
    close.addEventListener('click', hideToast);
    toastEl.appendChild(close);
    toastEl.hidden = false;
    if (timeout !== 0) toastTimer = setTimeout(hideToast, timeout || 12000);
  }

  function hideToast() {
    toastEl.hidden = true;
    toastEl.innerHTML = '';
  }

  // --------------------------------------------------------------- console

  /*
   * Page console output is batched before it crosses to the extension host: a page in
   * a render loop can log hundreds of lines a second, and one postMessage each would
   * drown the panel.
   */
  var consoleQueue = [];
  var consoleTimer = 0;

  function queueConsole(entry) {
    consoleQueue.push({ level: entry.level, text: entry.text, source: entry.source || '' });
    if (consoleQueue.length > 200) consoleQueue.splice(0, consoleQueue.length - 200);
    if (consoleTimer) return;
    consoleTimer = setTimeout(function () {
      consoleTimer = 0;
      var batch = consoleQueue;
      consoleQueue = [];
      vscode.postMessage({ type: 'console', entries: batch });
    }, 400);
  }

  // ----------------------------------------------------------------- clock

  function clockText() {
    if (state.clock === 'apple') return '9:41';
    if (state.clock === 'custom') return state.customClock || '9:41';
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    var dev = Catalog.byId(state.deviceId);
    if (dev.os === 'android') {
      return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m;
    }
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m;
  }

  setInterval(function () {
    if (state.clock !== 'real') return;
    var text = clockText();
    frames.forEach(function (f) { f.setClock(text); });
  }, 1000);

  // -------------------------------------------------------- host messaging

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    // Messages coming from the page inside the frame
    if (typeof msg.type === 'string' && msg.type.indexOf('dp:') === 0) return void onFrameMessage(msg, event);

    switch (msg.type) {
      case 'init':
        applyConfig(msg.config);
        Object.assign(state, msg.state || {});
        if (!Catalog.byId(state.deviceId)) state.deviceId = msg.config.defaultDevice;
        // Where the drawer sat and how the window was painted last time.
        if (state.devtoolsDock) dev.dock = state.devtoolsDock;
        if (state.devtoolsWidth) dev.width = state.devtoolsWidth;
        if (state.devtoolsHeight) dev.height = state.devtoolsHeight;
        applyTheme(state.theme || (msg.config && msg.config.theme));
        applyDock();
        history = msg.history || [];
        buildToolbar();
        renderStage();
        break;
      case 'config':
        applyConfig(msg.config);
        renderStage();
        break;
      case 'load':
        state.url = msg.url;
        state.realUrl = msg.real;
        state.proxied = !!msg.proxied;
        $('urlInput').value = msg.real && msg.real.indexOf('vscode-') !== 0 ? msg.real : '';
        frames.forEach(function (f) { setFrameSrc(f, msg.url); });
        updateToolbar();
        break;
      case 'start-page':
        loadStartPage();
        break;
      case 'ports': {
        ports = msg.ports || [];
        pushStartData();
        var first = ports[0];
        if (first && !state.realUrl) {
          // The scanner reports how each port speaks; http was assumed here, which is
          // wrong for every dev server that runs over TLS.
          var p = typeof first === 'object' ? first.port : first;
          var scheme = (typeof first === 'object' && first.scheme) || 'http';
          showToast('Dev server detected on port ' + p + '.', [
            { label: 'Preview it', primary: true, action: function () { navigate(scheme + '://localhost:' + p); } },
          ]);
        }
        break;
      }
      case 'collected':
        showToast('Saved to ' + msg.dir, [
          { label: 'Open folder', primary: true, action: function () {
            vscode.postMessage({ type: 'open-path', path: msg.dir });
          } },
          { label: 'Copy path', action: function () {
            vscode.postMessage({ type: 'copy', text: msg.dir });
          } },
        ], 14000);
        break;
      case 'recording-state':
        state.recording = msg.recording ? { since: Date.now() - (msg.seconds || 0) * 1000 } : null;
        if (msg.libraryRoot) state.libraryRoot = msg.libraryRoot;
        updateToolbar();
        break;
      case 'browser-log':
        // Chromium's own account of the page — refused frames, blocked dialogs,
        // failed requests. The page cannot see these, so they arrive by this route.
        dev.console.push({ level: msg.level, text: msg.text, source: msg.source || '', at: Date.now() });
        if (dev.console.length > 400) dev.console.splice(0, dev.console.length - 400);
        if (dev.open && dev.tab === 'console') renderDevtools();
        else updateToolbar();
        break;
      case 'library-root':
        state.libraryRoot = msg.root;
        showToast('Everything is now saved under ' + msg.root, [
          { label: 'Open it', primary: true, action: function () {
            vscode.postMessage({ type: 'open-path', path: msg.root });
          } },
        ], 9000);
        break;
      case 'captured':
        if (msg.error) { showToast('Capture failed: ' + msg.error, [], 8000); break; }
        // A recording is measured in time and frames; only a still has a width.
        var what = msg.kind === 'recording'
          ? 'Recording — ' + (msg.seconds ? msg.seconds + 's, ' : '') +
            msg.frames + ' frames at ' + msg.fps + ' fps'
          : 'Screenshot ' + msg.width + '×' + msg.height;
        showToast(
          what + (msg.clipboard ? ' — on the clipboard' : '') + '. Saved to ' + msg.file,
          [
            { label: 'Open folder', primary: true, action: function () {
              vscode.postMessage({ type: 'open-path', path: String(msg.file).replace(/[\\/][^\\/]+$/, '') });
            } },
            { label: 'Copy path', action: function () { vscode.postMessage({ type: 'copy', text: msg.file }); } },
          ],
          9000
        );
        break;
      case 'rpc':
        // The extension host has no way into the framed page, so it asks the panel
        // to relay the question and hand the answer back.
        window.__dpAsk(msg.message, msg.replyType, msg.timeout).then(function (result) {
          vscode.postMessage({ type: 'rpc-result', id: msg.id, result: result });
        });
        break;
      case 'command':
        runCommand(msg.name, msg.payload);
        break;
      default:
        break;
    }
  });

  function applyConfig(cfg) {
    if (!cfg) return;
    if (!state.deviceId || state.deviceId === 'iphone-16-pro') state.deviceId = cfg.defaultDevice || state.deviceId;
    if (state.statusBar === undefined) state.statusBar = cfg.statusBarStyle;
    state.customClock = cfg.customClock || state.customClock;
    if (cfg.clock) state.clock = cfg.clock;
    if (cfg.statusBarStyle) state.statusBar = cfg.statusBarStyle;
    if (cfg.statusBarLayout) state.statusBarLayout = cfg.statusBarLayout;
    if (typeof cfg.browserChrome === 'boolean') state.browserChrome = cfg.browserChrome;
    if (cfg.deviceFinish) state.finish = cfg.deviceFinish;
    if (cfg.background) state.background = cfg.background;
    if (typeof cfg.shadow === 'boolean') state.shadow = cfg.shadow;
    if (typeof cfg.showLabel === 'boolean') state.showLabel = cfg.showLabel;
    if (cfg.touchEmulation) state.touchEmulation = cfg.touchEmulation;
    // Where material is filed. Known from the start, so the camera menu names the
    // real folder instead of guessing at it.
    if (cfg.libraryRoot) state.libraryRoot = cfg.libraryRoot;
    if (cfg.version) state.version = cfg.version;
    if (cfg.logFile) state.logFile = cfg.logFile;
    // Remembered across restarts by the host, not by this window.
    if (cfg.theme && !state.theme) state.theme = cfg.theme;
    if (cfg.devtoolsDock && !state.devtoolsDock) state.devtoolsDock = cfg.devtoolsDock;
    if (cfg.devtoolsWidth && !state.devtoolsWidth) state.devtoolsWidth = cfg.devtoolsWidth;
    if (cfg.devtoolsHeight && !state.devtoolsHeight) state.devtoolsHeight = cfg.devtoolsHeight;
    if (cfg.gridDevices && cfg.gridDevices.length) state.gridDevices = cfg.gridDevices;
    if (cfg.zoom) {
      state.zoom = cfg.zoom === 'fit' || cfg.zoom === 'actual'
        ? cfg.zoom
        : (parseFloat(cfg.zoom) || 100) / 100;
    }
    if (cfg.display) state.display = cfg.display;
    if (typeof cfg.calibration === 'number' && cfg.calibration > 0) state.calibration = cfg.calibration;
  }

  function runCommand(name, payload) {
    switch (name) {
      case 'rotate': rotate(); break;
      case 'back': goBack(); break;
      case 'forward': goForward(); break;
      case 'reload': reload((payload && payload.mode) || 'normal'); break;
      case 'toggle-touch': toggleTouch(); break;
      case 'toggle-grid': toggleGrid(); break;
      case 'set-device': setDevice(payload.deviceId); break;
      case 'step-device': stepDevice(payload.delta); break;
      case 'copy-url':
        if (state.realUrl) vscode.postMessage({ type: 'copy', text: state.realUrl });
        break;
      case 'toggle-inspect': toggleInspect(); break;
      case 'capture': capture((payload && payload.mode) || 'frame'); break;
      case 'record':
        showToast('Recording…', [], 8000);
        vscode.postMessage(Object.assign({ type: 'record', url: state.realUrl, device: state.deviceId,
          orientation: state.orientation, finish: state.finish, statusBar: state.statusBar,
          statusBarLayout: state.statusBarLayout, clock: clockText(),
          browserChrome: state.browserChrome, background: state.background, custom: state.custom },
          payload || {}));
        break;
      case 'copy-element':
        if (!state.selection) {
          showToast('Nothing selected. Turn on the inspector and click an element first.');
          break;
        }
        vscode.postMessage({ type: 'element-for-ai', element: state.selection, device: describeDevice() });
        break;
      default: break;
    }
  }

  function onFrameMessage(msg, event) {
    switch (msg.type) {
      case 'dp:edits-active':
        // Live edits are replayed silently on every load, so the panel has to say
        // so — otherwise the page quietly disagrees with what the site serves.
        state.liveEdits = msg.count || 0;
        updateToolbar();
        break;
      case 'dp:ready':
        clearTimeout(blockedTimer);
        // A new document means the old tree is meaningless.
        dev.children = Object.create(null);
        dev.expanded = Object.create(null);
        dev.root = null;
        dev.selected = null;
        if (dev.open && dev.tab === 'elements') requestTree([]);
        if (msg.url && msg.url !== state.realUrl) {
          state.realUrl = msg.url;
          $('urlInput').value = msg.url;
          vscode.postMessage({ type: 'navigated', url: msg.url, title: msg.title });
        }
        // A page with no viewport meta is laid out at 980px by real mobile Safari.
        frames.forEach(function (f) {
          if (f.iframe.contentWindow !== event.source) return;
          f.setDesktopFallback(!msg.hasViewport);
          f.setScreenBackground(msg.background);
        });
        break;
      case 'dp:background':
        frames.forEach(function (f) {
          if (f.iframe.contentWindow === event.source) f.setScreenBackground(msg.background);
        });
        break;
      case 'dp:navigated':
        state.realUrl = msg.url;
        $('urlInput').value = msg.url;
        vscode.postMessage({ type: 'navigated', url: msg.url, title: msg.title });
        updateToolbar();
        break;
      case 'dp:title':
        vscode.postMessage({ type: 'navigated', url: state.realUrl, title: msg.title });
        break;
      case 'dp:element':
        if (msg.error) {
          showToast('Could not read that element: ' + msg.error);
          break;
        }
        state.selection = msg;
        renderSelection();
        vscode.postMessage({ type: 'selection', element: msg, device: describeDevice() });
        /*
         * Point at it on the phone, see it in the code.
         *
         * The drawer used to have to be open already, so picking an element showed a
         * summary at the bottom and nothing else — the markup you were pointing at
         * stayed hidden behind a button you had not pressed. Pointing IS the request
         * to see it, so the drawer opens on the tree and scrolls to that exact node.
         */
        if (msg.path) {
          if (!dev.open) toggleDevtools('elements');
          else if (dev.tab !== 'elements' && dev.tab !== 'styles') dev.tab = 'elements';
          revealPath(msg.path);
        }
        if (dev.open && dev.tab === 'styles') renderDevtools();
        break;
      case 'dp:console':
        queueConsole(msg);
        dev.console.push({ level: msg.level, text: msg.text, source: msg.source || '', at: Date.now() });
        if (dev.console.length > 500) dev.console.splice(0, dev.console.length - 500);
        if (dev.open) renderDevtools();
        break;
      case 'dp:tree':
        onTree(msg);
        break;
      case 'dp:start:navigate':
        navigate(msg.url);
        break;
      case 'dp:start:ready':
        pushStartData();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- shortcuts

  /*
   * Shortcuts by physical key, not by the letter printed on it.
   *
   * e.key is the character the layout produces: on a Russian keyboard Ctrl+R gives
   * "к" and Ctrl+L gives "д", so every one of these matched nothing and Ctrl+R fell
   * through to the browser, reloading the tool instead of the page. e.code names the
   * key itself, which is the same in every layout.
   *
   * Alt is tested before the plain reload branch: Ctrl+Alt+R is rotate, and reload
   * used to swallow it first.
   */
  window.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var code = e.code;
    if (e.altKey && code === 'KeyR') {
      e.preventDefault();
      rotate();
    } else if (code === 'KeyL') {
      e.preventDefault();
      $('urlInput').focus();
    } else if (code === 'KeyR') {
      e.preventDefault();
      reload(e.shiftKey ? 'hard' : 'normal');
    } else if (code === 'KeyD') {
      e.preventDefault();
      if (carouselEl.hidden) openDeviceCarousel();
      else closeCarousel();
    } else if (e.shiftKey && code === 'KeyC') {
      e.preventDefault();
      toggleDevtools('elements');
    } else if (e.shiftKey && code === 'KeyJ') {
      e.preventDefault();
      toggleDevtools('console');
    } else if (code === 'Digit0' || code === 'Numpad0') {
      e.preventDefault();
      setZoom('fit');
    } else if (code === 'Equal' || code === 'NumpadAdd') {
      e.preventDefault();
      setZoom(clamp((state.zoom === 'fit' ? currentScale() : state.zoom) * 1.25, 0.1, 4));
    } else if (code === 'Minus' || code === 'NumpadSubtract') {
      e.preventDefault();
      setZoom(clamp((state.zoom === 'fit' ? currentScale() : state.zoom) / 1.25, 0.1, 4));
    }
  });

  function currentScale() {
    if (!primary) return 1;
    return parseFloat(primary.root.style.getPropertyValue('--scale')) || 1;
  }

  stageEl.addEventListener(
    'wheel',
    function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var base = state.zoom === 'fit' ? currentScale() : state.zoom;
      setZoom(clamp(base * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 4));
    },
    { passive: false }
  );

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitZoom, 60);
  });

  window.addEventListener('error', function (e) {
    vscode.postMessage({ type: 'error', message: (e.message || 'error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0) });
  });

  // ------------------------------------------------------------------ boot

  var saved = vscode.getState();
  if (saved) Object.assign(state, saved);
  buildToolbar();
  vscode.postMessage({ type: 'ready' });
})();
