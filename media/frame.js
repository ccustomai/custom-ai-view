/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Builds a device out of DOM nodes: body, bezels, cutout, status bar, hardware
 * buttons, home indicator, optional browser chrome, and the iframe that is the
 * actual viewport.
 *
 * The iframe is laid out at the device's real CSS-pixel size and only *visually*
 * scaled by the wrapper, so the page inside always believes it is on a 393-point
 * screen even when the frame is drawn at 55%.
 */
(function (root) {
  'use strict';

  var Catalog = root.DeviceCatalog;

  // ------------------------------------------------------------------ icons

  function svg(width, height, body, viewBox) {
    return (
      '<svg width="' + width + '" height="' + height + '" viewBox="' + (viewBox || '0 0 ' + width + ' ' + height) +
      '" fill="none" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>'
    );
  }

  var ICON = {
    /** The mark at the left of every Mac menu bar. */
    appleLogo: function () {
      return svg(14, 16,
        '<path fill="currentColor" d="M9.6 2.1c.5-.6.8-1.4.7-2.1-.7 0-1.5.4-2 1-.4.5-.8 1.3-.7 2.1.8 0 1.6-.4 2-1zM11.9 ' +
        '11.5c-.3.8-.5 1.1-.9 1.8-.6.9-1.4 2.1-2.4 2.1-.9 0-1.1-.6-2.4-.6s-1.5.6-2.4.6c-1 0-1.8-1-2.4-2C.7 11.7.5 8.7 ' +
        '1.5 7.1c.7-1.1 1.8-1.8 2.9-1.8 1.1 0 1.8.6 2.7.6.9 0 1.4-.6 2.7-.6.9 0 1.9.5 2.6 1.4-2.3 1.3-2 4.6.1 5.8z"/>');
    },
    signalIOS: function () {
      var bars = '';
      for (var i = 0; i < 4; i++) {
        var h = 4 + i * 2.4;
        bars +=
          '<rect x="' + i * 4.6 + '" y="' + (11.4 - h) + '" width="3.2" height="' + h +
          '" rx="1" fill="currentColor"/>';
      }
      return svg(18, 12, bars);
    },
    wifiIOS: function () {
      return svg(
        17, 12,
        '<path d="M8.5 10.6 6.6 8.5a2.7 2.7 0 0 1 3.8 0L8.5 10.6Z" fill="currentColor"/>' +
        '<path d="M4.5 6.6a5.9 5.9 0 0 1 8 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
        '<path d="M1.6 3.7a9.9 9.9 0 0 1 13.8 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
      );
    },
    batteryIOS: function (pct) {
      var level = Math.max(0, Math.min(100, pct === undefined ? 88 : pct));
      var fillW = (18.5 * level) / 100;
      return svg(
        27, 13,
        '<rect x=".6" y=".6" width="21.8" height="11.8" rx="3.6" stroke="currentColor" stroke-opacity=".38" stroke-width="1.1"/>' +
        '<rect x="2.3" y="2.3" width="' + fillW.toFixed(1) + '" height="8.4" rx="2.1" fill="currentColor"/>' +
        '<path d="M24 4.4a2.6 2.6 0 0 1 0 4.2V4.4Z" fill="currentColor" fill-opacity=".42"/>'
      );
    },
    signalAndroid: function () {
      return svg(
        15, 12,
        '<path d="M14 1.2v9.6a.6.6 0 0 1-1 .45L1.2 2.1A.6.6 0 0 1 1.6 1h11.8a.6.6 0 0 1 .6.2Z" fill="currentColor" fill-opacity=".95"/>'
      );
    },
    wifiAndroid: function () {
      return svg(
        16, 12,
        '<path d="M8 11 .8 3.4a10.6 10.6 0 0 1 14.4 0L8 11Z" fill="currentColor"/>'
      );
    },
    batteryAndroid: function (pct) {
      var level = Math.max(0, Math.min(100, pct === undefined ? 88 : pct));
      var fillH = (9.2 * level) / 100;
      return svg(
        11, 14,
        '<rect x="1.6" y="1.4" width="7.8" height="11.4" rx="1.8" stroke="currentColor" stroke-width="1.1" stroke-opacity=".55"/>' +
        '<rect x="4" y=".2" width="3" height="1.6" rx=".7" fill="currentColor" fill-opacity=".55"/>' +
        '<rect x="2.9" y="' + (11.5 - fillH).toFixed(1) + '" width="5.2" height="' + fillH.toFixed(1) + '" rx="1" fill="currentColor"/>'
      );
    },
    lock: function () {
      return svg(
        11, 13,
        '<rect x=".9" y="5.2" width="9.2" height="7.2" rx="2" fill="currentColor" fill-opacity=".62"/>' +
        '<path d="M3.2 5.2V3.6a2.3 2.3 0 0 1 4.6 0v1.6" stroke="currentColor" stroke-opacity=".62" stroke-width="1.3"/>'
      );
    },
    chevron: function (dir) {
      var d = dir === 'left' ? 'M8 2 4 7l4 5' : 'M4 2l4 5-4 5';
      return svg(12, 14, '<path d="' + d + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
    },
    share: function () {
      return svg(
        14, 16,
        '<path d="M7 10.5V1.8M7 1.8 4.3 4.5M7 1.8l2.7 2.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M2.4 7.6v6.2h9.2V7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      );
    },
    book: function () {
      return svg(14, 14, '<path d="M1.4 2.2h5.2v10.4H1.4zM7.4 2.2h5.2v10.4H7.4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>');
    },
    tabs: function () {
      return svg(
        14, 14,
        '<rect x="1" y="1" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.5"/>' +
        '<rect x="5" y="5" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.5"/>'
      );
    },
    reload: function () {
      return svg(
        13, 13,
        '<path d="M11.4 6.5a4.9 4.9 0 1 1-1.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M11.6.9v3.2H8.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    },
    aA: function () {
      return '<span style="font-size:13px;letter-spacing:-.5px">A<span style="font-size:16px">A</span></span>';
    },
    dots: function () {
      return svg(
        16, 4,
        '<circle cx="2" cy="2" r="1.6" fill="currentColor"/><circle cx="8" cy="2" r="1.6" fill="currentColor"/><circle cx="14" cy="2" r="1.6" fill="currentColor"/>'
      );
    },
  };

  // ------------------------------------------------------------------ build

  var el = function (tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  /*
   * What the framed page is allowed to do.
   *
   * Inside VS Code these are a ceiling, not a grant: sandbox flags are inherited from
   * the webview's own frame and can only be tightened, and only features present in
   * the ancestor's permissions policy can be re-delegated. Asking for more there is
   * simply ignored.
   *
   * In the standalone app there is no such ancestor — app/window.html is an ordinary
   * top-level document — so everything asked for here is actually granted. That
   * distinction cost real time: without allow-modals, window.confirm() returns false
   * with no dialog, so every "if (!confirm(...)) return;" quietly does nothing, and
   * Sign out and Delete account look broken with an empty console. Without camera,
   * microphone and geolocation, a voice assistant and a live map fail the same silent
   * way. Asking for all of them is harmless where it is refused and correct where it
   * is not.
   */
  function makeIframe() {
    var iframe = document.createElement('iframe');
    iframe.className = 'dev-frame';
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups'
    );
    iframe.setAttribute(
      'allow',
      'autoplay; clipboard-read; clipboard-write; camera; microphone; geolocation'
    );
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    return iframe;
  }

  /** Perceived brightness of a CSS colour, 0 to 1, or null if it cannot be read. */
  function luminance(color) {
    var rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color);
    var r, g, b;
    if (rgb) {
      r = parseFloat(rgb[1]); g = parseFloat(rgb[2]); b = parseFloat(rgb[3]);
    } else {
      var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
      if (!hex) return null;
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function hostOf(url) {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch (e) {
      return url || '';
    }
  }

  /**
   * @param {object} device  raw catalogue entry
   * @param {object} opts    {orientation, finish, statusBar, clock, browserChrome,
   *                          showLabel, shadow, glare, url, custom, scale}
   */
  function build(device, opts) {
    opts = opts || {};
    var orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
    var d = Catalog.oriented(device, orientation, opts.custom);
    var landscape = orientation === 'landscape';
    var isPhone = d.kind === 'phone';
    var isMac = d.os === 'macos';

    var chromeOn = !!opts.browserChrome && d.chrome && d.chrome.kind !== 'none';
    var chromeTop = chromeOn ? (d.chrome.top || 0) + (d.chrome.menuBar || 0) : 0;
    var chromeBottom = chromeOn ? d.chrome.bottom || 0 : 0;

    // The inset can be much taller than the glyph strip on Android phones with a
    // large camera cutout (Pixel 9 reserves 66pt), so cap where the glyphs sit.
    var statusInset = landscape && !d.homeButton && isPhone ? 21 : d.safeTop;
    var statusHeight = d.os === 'android' ? Math.min(statusInset, 44) : statusInset;
    var showStatus = opts.statusBar !== 'hidden' && !isMac && statusHeight > 0;

    // The status bar is not transparent to content by default: on a real phone the
    // page begins below it, and only a full-screen app with viewport-fit=cover
    // draws underneath. "overlay" opts into that edge-to-edge behaviour.
    var overlay = opts.statusBarLayout === 'overlay';
    /*
     * macOS reserves the menu bar at the top of every screen and nothing draws under
     * it — which is why the notch is never over a web page on a Mac. With the browser
     * chrome shown, that chrome already includes a menu bar of its own; without it,
     * one is drawn here, because a Mac screen without a menu bar is not a Mac screen.
     */
    var macMenuBar = isMac && !chromeOn;
    // On a notched Mac the bar is exactly as tall as the notch, so the notch reads as
    // cut out of it rather than sitting on top of it.
    var menuBarHeight = macMenuBar ? (d.cutout === 'mac-notch' ? d.ch : 24) : 0;
    var padTop = chromeOn
      ? (isMac ? chromeTop : d.safeTop + (d.chrome.top || 0))
      : (overlay ? 0 : isMac ? menuBarHeight : statusInset);
    /*
     * Nothing is carved out at the bottom.
     *
     * The home indicator is not furniture the page has to sit above — it floats over
     * the page, and the page runs to the physical edge of the glass. Insetting by
     * safeBottom drew a band no phone has, and cost the viewport 34 of its 874
     * points, so the page was told one height and given another. The inset still
     * reaches anything that asks for it, through env(safe-area-inset-bottom), which
     * is exactly how a device reports it.
     *
     * With browser chrome the toolbar is real furniture, and its height already
     * includes the safe area (see .chrome-ios-bottom), so there the page is inset by
     * the whole bar.
     */
    var padBottom = chromeOn ? chromeBottom + d.safeBottom : 0;
    // In landscape iOS insets both sides, not just the one the cutout is on.
    var padSide = overlay || !landscape ? 0 : d.safeSide || 0;

    var bodyW = d.w + d.bezel.l + d.bezel.r;
    var bodyH = d.h + d.bezel.t + d.bezel.b;
    // The real corner where it is known; otherwise the screen's rounding carried out
    // through the bezel, which is what it looks like on devices we have no figure for.
    var bodyRadius = d.bodyRadius
      ? d.bodyRadius
      : d.homeButton ? (d.kind === 'tablet' ? 44 : 58)
      : isMac ? 14
      : d.radius + Math.max(d.bezel.l, d.bezel.r);

    var root = el('div', 'dev');
    root.dataset.os = d.os;
    root.dataset.kind = d.kind;
    root.dataset.cutout = d.cutout;
    root.dataset.orient = orientation;
    root.dataset.finish = opts.finish && d.finishes.indexOf(opts.finish) >= 0 ? opts.finish : d.finishes[0];
    // "auto" starts dark and flips as soon as the page reports its background.
    root.dataset.sb = opts.statusBar === 'light' ? 'light' : 'dark';
    root.dataset.shadow = opts.shadow === false ? 'off' : 'on';
    root.dataset.deviceId = d.id;

    var sbPad = landscape
      ? Math.max(d.safeSide || 0, 34)
      : Math.max(20, Math.round(d.radius * 0.42) + 8);
    // A hole in the top-left corner sits where the clock would go, so push past it.
    var sbPadLeft = d.cutout === 'hole-left' && !landscape ? Math.max(sbPad, d.ct + d.cw + 14) : sbPad;

    var style = {
      '--w': d.w + 'px',
      '--h': d.h + 'px',
      '--r': d.radius + 'px',
      '--bt': d.bezel.t + 'px',
      '--br': d.bezel.r + 'px',
      '--bb': d.bezel.b + 'px',
      '--bl': d.bezel.l + 'px',
      '--safe-t': d.safeTop + 'px',
      '--safe-b': d.safeBottom + 'px',
      '--cw': d.cw + 'px',
      '--ch': d.ch + 'px',
      '--ct': d.ct + 'px',
      '--body-r': bodyRadius + 'px',
      '--pad-t': padTop + 'px',
      '--pad-b': padBottom + 'px',
      '--pad-l': padSide + 'px',
      '--pad-r': padSide + 'px',
      '--chrome-t': ((d.chrome && d.chrome.top) || 0) + 'px',
      '--chrome-b': chromeBottom + 'px',
      '--menu-h': ((d.chrome && d.chrome.menuBar) || 0) + 'px',
      '--macbar-h': menuBarHeight + 'px',
      '--sb-h': statusHeight + 'px',
      '--sb-pad': sbPad + 'px',
      '--sb-pad-l': sbPadLeft + 'px',
      '--sb-shift': d.cutout === 'island' && !landscape ? '2px' : '0px',
      '--home-w': Math.round(d.w * (landscape ? 0.26 : 0.36)) + 'px',
      '--hb-size': d.kind === 'tablet' ? '46px' : '58px',
      '--glare': opts.glare === false ? '0' : '.5',
      '--scale': opts.scale || 1,
    };
    Object.keys(style).forEach(function (k) {
      root.style.setProperty(k, String(style[k]));
    });

    var shell = el('div', 'dev-shell');
    var scaleWrap = el('div', 'dev-scale');
    var body = el('div', 'dev-body');
    var screen = el('div', 'dev-screen');
    var page = el('div', 'dev-page');

    var iframe = makeIframe();
    page.appendChild(iframe);
    screen.appendChild(page);

    /*
     * ---- the Mac menu bar, and the notch that lives in it
     *
     * A Mac always has a menu bar, and a browser window never draws under it — so the
     * notch is never over the web page. Drawing it there put a black rectangle on top
     * of the site, which is not something anyone has ever seen on a Mac, and it left
     * the frame looking like a monitor with a bite taken out of it. The bar is part of
     * the screen: the page starts below it, exactly as it does on the desk.
     */
    if (macMenuBar) {
      var menubar = el('div', 'dev-menubar');
      menubar.innerHTML =
        '<span class="mb-left">' + ICON.appleLogo() +
          '<b>Safari</b><span>File</span><span>Edit</span><span>View</span>' +
          '<span>History</span><span>Bookmarks</span><span>Window</span><span>Help</span></span>' +
        '<span class="mb-right">' + ICON.batteryIOS(opts.battery) +
          '<span>' + escapeHtml(opts.clock || '9:41') + '</span></span>';
      screen.appendChild(menubar);
    }
    // The notch belongs to the display, above whatever is drawn in the bar.
    if (d.cutout !== 'none') screen.appendChild(el('div', 'dev-cutout'));

    // ---- status bar
    var status = null;
    if (showStatus) {
      status = el('div', 'dev-status');
      var time = el('span', 'sb-time', opts.clock || '9:41');
      var right = el('span', 'sb-right');
      if (d.os === 'android') {
        right.innerHTML = ICON.wifiAndroid() + ICON.signalAndroid() + ICON.batteryAndroid(opts.battery);
      } else {
        right.innerHTML = ICON.signalIOS() + ICON.wifiIOS() + ICON.batteryIOS(opts.battery);
      }
      status.appendChild(time);
      status.appendChild(right);
      screen.appendChild(status);
    }

    // ---- home indicator / home button
    if (d.safeBottom > 0 && !d.homeButton) screen.appendChild(el('div', 'dev-home'));

    // ---- browser chrome
    if (chromeOn) {
      var chromeNodes = buildChrome(d, opts.url, chromeBottom);
      chromeNodes.forEach(function (node) {
        screen.appendChild(node);
      });
    }

    if (opts.glare !== false) screen.appendChild(el('div', 'dev-glare'));

    body.appendChild(screen);

    // ---- hardware
    (d.buttons || []).forEach(function (b) {
      var btn = el('span', 'dev-btn');
      btn.dataset.side = b.side;
      btn.dataset.type = b.type;
      var along = b.side === 'left' || b.side === 'right' ? d.h : d.w;
      if (b.side === 'left' || b.side === 'right') {
        btn.style.top = Math.round(b.top * along) + d.bezel.t + 'px';
        btn.style.height = Math.round(b.len * along) + 'px';
      } else {
        btn.style.left = Math.round(b.top * along) + d.bezel.l + 'px';
        btn.style.width = Math.round(b.len * along) + 'px';
      }
      body.appendChild(btn);
    });

    if (d.homeButton) {
      body.appendChild(el('div', 'dev-homebtn'));
      if (d.kind === 'phone') body.appendChild(el('div', 'dev-speaker'));
    }

    if (isMac && d.kind === 'laptop') {
      body.appendChild(el('div', 'dev-chin', d.name.indexOf('Air') >= 0 ? 'MacBook Air' : 'MacBook Pro'));
    }

    scaleWrap.appendChild(body);
    if (isMac && d.kind === 'laptop') scaleWrap.appendChild(el('div', 'dev-base'));
    if (isMac && d.kind === 'desktop') scaleWrap.appendChild(el('div', 'dev-stand'));

    shell.appendChild(scaleWrap);
    root.appendChild(shell);

    var label = null;
    if (opts.showLabel !== false) {
      label = el('div', 'dev-label');
      label.innerHTML = labelHtml(d, device);
      root.appendChild(label);
    }

    var api = {
      root: root,
      iframe: iframe,
      page: page,
      status: status,
      label: label,
      device: d,
      /** Size of the layout box after scaling, so the stage can centre it. */
      metrics: function () {
        var scale = parseFloat(root.style.getPropertyValue('--scale')) || 1;
        // Room below the lid for the half you type on, or for a display's stand.
        // Keep in step with .dev-base and .dev-stand: too small and the capture cuts
        // the base in half, which is how the frame came to look like a monitor.
        var extra = isMac && d.kind === 'laptop' ? 30 : isMac && d.kind === 'desktop' ? 90 : 0;
        return {
          w: bodyW * scale,
          h: (bodyH + extra) * scale,
          rawW: bodyW,
          rawH: bodyH + extra,
          viewportW: d.w,
          viewportH: d.h - padTop - padBottom,
        };
      },
      setScale: function (scale) {
        root.style.setProperty('--scale', String(scale));
        var m = api.metrics();
        shell.style.width = m.w + 'px';
        shell.style.height = m.h + 'px';
      },
      /**
       * Reload without touching history. Re-navigating an existing iframe pushes a
       * joint-session-history entry, which would poison the back button; a freshly
       * inserted iframe's first navigation replaces its initial entry instead.
       */
      recreateIframe: function (src) {
        var next = makeIframe();
        api.iframe.replaceWith(next);
        api.iframe = next;
        if (src) next.src = src;
        return next;
      },
      setClock: function (text) {
        if (status) status.querySelector('.sb-time').textContent = text;
      },
      /**
       * Paint the screen behind the page in the page's own background colour, so
       * the status-bar strip blends into the app the way it does on a real phone
       * instead of showing a white band above a dark page.
       *
       * In "auto" mode this also decides the glyph colour: black numerals on a dark
       * app are invisible, and iOS makes exactly this call from the app's own style.
       */
      setScreenBackground: function (color) {
        if (!color || /transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(color)) return;
        screen.style.background = color;
        if (opts.statusBar && opts.statusBar !== 'auto') return;
        var lum = luminance(color);
        if (lum === null) return;
        root.dataset.sb = lum > 0.55 ? 'dark' : 'light';
      },
      /** Emulate mobile Safari's 980px fallback for pages with no viewport meta. */
      setDesktopFallback: function (on) {
        if (on) {
          page.dataset.fallback = '980';
          page.style.setProperty('--fallback-scale', String(d.w / 980));
        } else {
          delete page.dataset.fallback;
          page.style.removeProperty('--fallback-scale');
        }
      },
    };

    api.setScale(opts.scale || 1);
    return api;
  }

  function labelHtml(d) {
    var chunk = function (text) {
      return '<span class="chunk">' + text + '</span>';
    };
    var parts = [
      chunk(d.w + ' × ' + d.h + ' pt'),
      chunk('@' + d.dpr + 'x'),
      chunk(Math.round(d.w * d.dpr) + ' × ' + Math.round(d.h * d.dpr) + ' px'),
    ];
    // The real thing you could hold: screen area in millimetres.
    if (d.mmPerPt) {
      parts.push(chunk((d.w * d.mmPerPt).toFixed(0) + ' × ' + (d.h * d.mmPerPt).toFixed(0) + ' mm'));
    }
    if (d.safeTop || d.safeBottom) parts.push(chunk('safe ' + d.safeTop + '/' + d.safeBottom));
    return (
      '<b>' + escapeHtml(d.name) + '</b><br>' +
      parts.join('<span class="dot">·</span>')
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildChrome(d, url, chromeBottom) {
    var host = hostOf(url);
    var out = [];
    var kind = d.chrome.kind;

    if (kind === 'ios-safari') {
      var bottom = el('div', 'dev-chrome chrome-ios-bottom');
      bottom.dataset.pos = 'bottom';
      bottom.innerHTML =
        '<div class="url-pill">' + ICON.aA() +
        '<span class="host">' + escapeHtml(host || 'start page') + '</span>' + ICON.reload() + '</div>' +
        '<div class="row">' + ICON.chevron('left') + ICON.chevron('right') + ICON.share() + ICON.book() + ICON.tabs() + '</div>';
      out.push(bottom);
    } else if (kind === 'ios-safari-legacy') {
      var top = el('div', 'dev-chrome chrome-ios-top');
      top.dataset.pos = 'top';
      top.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:44px;padding:0 14px">' +
        '<div style="height:30px;flex:1;border-radius:9px;background:rgba(118,118,128,.12);display:flex;' +
        'align-items:center;justify-content:center;font-size:14px;gap:5px">' +
        ICON.lock() + escapeHtml(host || 'start page') + '</div></div>';
      out.push(top);
      var legacyBottom = el('div', 'dev-chrome chrome-ios-bottom');
      legacyBottom.dataset.pos = 'bottom';
      legacyBottom.innerHTML =
        '<div class="row" style="padding:8px 8px 0">' +
        ICON.chevron('left') + ICON.chevron('right') + ICON.share() + ICON.book() + ICON.tabs() + '</div>';
      out.push(legacyBottom);
    } else if (kind === 'ipados-safari') {
      var ipad = el('div', 'dev-chrome chrome-ipad-top');
      ipad.dataset.pos = 'top';
      ipad.innerHTML =
        '<div class="tabbar"><div class="tab">' + escapeHtml(host || 'Start Page') + '</div></div>' +
        '<div class="toolbar">' + ICON.chevron('left') + ICON.chevron('right') +
        '<div class="url-pill">' + escapeHtml(host || 'Search or enter website name') + '</div>' +
        ICON.share() + ICON.tabs() + '</div>';
      out.push(ipad);
    } else if (kind === 'android-chrome') {
      var and = el('div', 'dev-chrome chrome-android-top');
      and.dataset.pos = 'top';
      and.innerHTML =
        '<div class="url-pill">' + ICON.lock() + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' +
        escapeHtml(host || 'Search or type URL') + '</span>' + ICON.dots() + '</div>';
      out.push(and);
    } else if (kind === 'macos-safari') {
      var mac = el('div', 'dev-chrome chrome-mac-top');
      mac.dataset.pos = 'top';
      mac.innerHTML =
        '<div class="menubar"><b style="font-weight:700">Safari</b><span>File</span><span>Edit</span>' +
        '<span>View</span><span>History</span><span>Bookmarks</span><span>Window</span><span>Help</span>' +
        '<span class="spacer"></span><span>' + escapeHtml(new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) + '</span></div>' +
        '<div class="lights"><i></i><i></i><i></i></div>' +
        '<div class="toolbar">' + ICON.chevron('left') + ICON.chevron('right') +
        '<div class="url-pill">' + ICON.lock() + '&nbsp;' + escapeHtml(host || 'Search or enter website name') + '</div>' +
        ICON.share() + ICON.tabs() + '</div>';
      out.push(mac);
    }
    return out;
  }

  root.DeviceFrame = { build: build, ICON: ICON, hostOf: hostOf, escapeHtml: escapeHtml };
})(window);
