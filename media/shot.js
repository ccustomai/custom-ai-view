/*
 * Capture page controller.
 *
 * Builds the same device frame the panel shows, loads the same proxied URL, and then
 * publishes the rectangles the screenshotter needs. Everything it exposes lives on
 * window so the DevTools client can read it with a single Runtime.evaluate.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var get = function (name, fallback) {
    var v = params.get(name);
    return v === null || v === '' ? fallback : v;
  };

  var deviceId = get('device', 'iphone-16-pro');
  var url = get('url', '');
  var mode = get('mode', 'frame');
  var selector = get('selector', '');
  var padding = parseInt(get('pad', mode === 'frame' ? '48' : '0'), 10);

  document.body.dataset.bg = get('bg', mode === 'frame' ? 'studio' : 'none');
  document.getElementById('stage').style.setProperty('--pad', padding + 'px');

  var api = window.DeviceFrame.build(window.DeviceCatalog.byId(deviceId), {
    orientation: get('orientation', 'portrait'),
    finish: get('finish', 'graphite'),
    statusBar: get('statusBar', 'auto'),
    statusBarLayout: get('statusBarLayout', 'inset'),
    clock: get('clock', '9:41'),
    browserChrome: get('chrome', '0') === '1',
    showLabel: get('label', '0') === '1',
    shadow: get('shadow', mode === 'frame' ? '1' : '0') === '1',
    glare: get('glare', '1') === '1',
    url: get('real', url),
    scale: 1,
    custom: params.get('cw')
      ? { w: parseInt(params.get('cw'), 10), h: parseInt(params.get('ch'), 10), dpr: parseFloat(params.get('cd') || '2') }
      : null,
  });

  document.getElementById('stage').appendChild(api.root);
  window.__SHOT_API__ = api;

  // Sized so nothing is clipped by the viewport; the capture clips precisely later.
  var metrics = api.metrics();
  window.__SHOT_SIZE__ = {
    width: Math.ceil(metrics.rawW + padding * 2),
    height: Math.ceil(metrics.rawH + padding * 2 + (get('label', '0') === '1' ? 44 : 0)),
  };

  window.__SHOT_STATE__ = { ready: false, reason: 'loading', elementRect: null };

  var settle = function (reason) {
    // A frame or two after load lets fonts swap and layout settle before the shot.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(function () {
          window.__SHOT_STATE__.ready = true;
          window.__SHOT_STATE__.reason = reason;
        }, parseInt(get('settle', '350'), 10));
      });
    });
  };

  var wantsDescription = get('describe', '0') === '1';

  api.iframe.addEventListener('load', function () {
    if (selector) {
      try {
        api.iframe.contentWindow.postMessage({ type: 'dp:cmd:highlight', selector: selector }, '*');
        api.iframe.contentWindow.postMessage({ type: 'dp:cmd:locate', selector: selector }, '*');
      } catch (e) { /* not proxied, so no shim to talk to */ }
    }
    if (wantsDescription) {
      try {
        api.iframe.contentWindow.postMessage({ type: 'dp:cmd:describe', selector: selector }, '*');
      } catch (e) { /* ignore */ }
    }
    settle('load');
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'dp:located' && msg.rect) {
      // Map the rect from the page's coordinate space into the capture page's, and
      // leave room for the highlight ring, which is drawn outside the element's box.
      var frameBox = api.iframe.getBoundingClientRect();
      var ring = 8;
      window.__SHOT_STATE__.elementRect = {
        x: frameBox.left + window.scrollX + msg.rect.x - ring,
        y: frameBox.top + window.scrollY + msg.rect.y - ring,
        width: msg.rect.width + ring * 2,
        height: msg.rect.height + ring * 2,
      };
    }
    if (msg.type === 'dp:described') {
      window.__SHOT_ELEMENT__ = msg;
    }
    if (msg.type === 'dp:ready') {
      api.setScreenBackground(msg.background);
      api.setDesktopFallback(!msg.hasViewport);
    }
  });

  /** Rectangles the screenshotter can clip to, in capture-page coordinates. */
  window.__SHOT_RECTS__ = function () {
    var shell = api.root.querySelector('.dev-shell');
    var screen = api.root.querySelector('.dev-screen');
    var page = api.page;
    var box = function (el) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    };
    var shellBox = box(shell);
    if (shellBox && padding) {
      shellBox = {
        x: shellBox.x - padding,
        y: shellBox.y - padding,
        width: shellBox.width + padding * 2,
        height: shellBox.height + padding * 2,
      };
    }
    return {
      frame: shellBox,
      screen: box(screen),
      page: box(page),
      element: window.__SHOT_STATE__.elementRect,
    };
  };

  if (url) {
    api.iframe.src = url;
  } else {
    settle('no-url');
  }

  // Never hang forever on a page that will not finish loading.
  setTimeout(function () {
    if (!window.__SHOT_STATE__.ready) settle('timeout');
  }, parseInt(get('timeout', '9000'), 10));
})();
