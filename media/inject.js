/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Page shim, injected by the local proxy.
 *
 * Makes a desktop Chromium page behave like a phone:
 *   - real TouchEvents synthesised from pointer input, with the correct
 *     touchstart/touchmove/touchend sequence and preventDefault semantics
 *   - drag-to-scroll with momentum, skipped when the page handles touchmove itself
 *   - navigator / screen / matchMedia report the emulated device
 *   - every request and navigation stays inside the proxy
 *   - the frame reports its URL, title and scroll position to the panel
 *
 * Every block is defensive: a failure here must never blank the page.
 */
(function () {
  'use strict';

  var CFG = window.__DEVICE_PREVIEW__ || {};
  var PREFIX = '/' + CFG.token + '/' + CFG.key;
  var PROFILE = CFG.profile || {};
  var TOUCH = PROFILE.touch !== false;

  if (window.__DEVICE_PREVIEW_ACTIVE__) return;
  window.__DEVICE_PREVIEW_ACTIVE__ = true;

  function safe(label, fn) {
    try {
      fn();
    } catch (err) {
      try {
        console.warn('[custom-ai-view] ' + label + ' failed:', err);
      } catch (e) {}
    }
  }

  function toParent(msg) {
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
    } catch (e) {}
  }

  /*
   * Chrome treats touchstart/touchmove listeners registered on window, document and
   * body as passive unless told otherwise, which makes preventDefault() a no-op
   * there — and that is exactly where carousels, maps and drawers register their
   * "I am handling this gesture" handlers. Since synthetic touch events have no
   * default action, defaultPrevented is the ONLY signal the page can give the
   * shim, so this patch has to be installed before any page script runs.
   */
  safe('passive listener patch', function () {
    var TOUCHY = { touchstart: 1, touchmove: 1, wheel: 1, mousewheel: 1 };
    var native = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (TOUCHY[type]) {
        if (options === undefined || typeof options === 'boolean') {
          options = { capture: !!options, passive: false };
        } else if (options && typeof options === 'object' && options.passive === undefined) {
          options = Object.assign({}, options, { passive: false });
        }
      }
      return native.call(this, type, listener, options);
    };
  });

  // ------------------------------------------------------------ URL routing

  var b64url = function (s) {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /** Absolute http(s) URL -> proxied path. Anything else is returned untouched. */
  function proxify(input) {
    if (!input) return input;
    var str = String(input);
    if (str.indexOf('/' + CFG.token + '/') === 0) return str;
    if (/^(data|blob|javascript|mailto|tel|about|#):?/i.test(str) || str.charAt(0) === '#') return str;
    var u;
    try {
      u = new URL(str, location.href);
    } catch (e) {
      return str;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return str;
    if (u.origin === location.origin) return u.href; // already on the proxy
    return location.origin + '/' + CFG.token + '/' + b64url(u.origin) + u.pathname + u.search + u.hash;
  }

  /** Proxied URL -> the real one, for anything shown to the user. */
  function realUrl(input) {
    var str = String(input || location.href);
    try {
      var u = new URL(str, location.href);
      if (u.origin !== location.origin) return u.href;
      var m = u.pathname.match(/^\/[0-9a-f]+\/([A-Za-z0-9_-]+)(\/.*)?$/);
      if (!m) return u.href;
      var origin = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
      return origin + (m[2] || '/') + u.search + u.hash;
    } catch (e) {
      return str;
    }
  }

  safe('fetch patch', function () {
    var nativeFetch = window.fetch;
    if (!nativeFetch) return;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          return nativeFetch.call(this, proxify(String(input)), init);
        }
        if (input && input.url) {
          var next = proxify(input.url);
          if (next !== input.url) return nativeFetch.call(this, new Request(next, input), init);
        }
      } catch (e) {}
      return nativeFetch.call(this, input, init);
    };
  });

  safe('xhr patch', function () {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = proxify(url);
      return open.apply(this, args);
    };
  });

  safe('beacon patch', function () {
    if (!navigator.sendBeacon) return;
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return beacon(proxify(url), data);
    };
  });

  safe('eventsource patch', function () {
    if (!window.EventSource) return;
    var Native = window.EventSource;
    window.EventSource = function (url, cfg) {
      return new Native(proxify(url), cfg);
    };
    window.EventSource.prototype = Native.prototype;
  });

  safe('websocket patch', function () {
    if (!window.WebSocket) return;
    var Native = window.WebSocket;
    function Patched(url, protocols) {
      var next = url;
      try {
        var u = new URL(String(url), location.href);
        if (u.protocol === 'ws:' || u.protocol === 'wss:') {
          var httpOrigin = (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
          if (httpOrigin !== location.origin.replace(/^http/, 'http')) {
            next =
              (location.protocol === 'https:' ? 'wss://' : 'ws://') +
              location.host +
              '/' + CFG.token + '/' + b64url(httpOrigin) + u.pathname + u.search;
          }
        }
      } catch (e) {}
      return protocols === undefined ? new Native(next) : new Native(next, protocols);
    }
    Patched.prototype = Native.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) {
      Patched[k] = i;
    });
    window.WebSocket = Patched;
  });

  safe('history patch', function () {
    ['pushState', 'replaceState'].forEach(function (name) {
      var native = history[name];
      history[name] = function (state, title, url) {
        if (url !== undefined && url !== null) {
          try {
            var next = new URL(String(url), location.href);
            if (next.origin !== location.origin) {
              return native.call(this, state, title, proxify(next.href));
            }
          } catch (e) {}
        }
        var result = native.apply(this, arguments);
        reportUrl();
        return result;
      };
    });
    window.addEventListener('popstate', reportUrl);
    window.addEventListener('hashchange', reportUrl);
  });

  safe('navigation intercept', function () {
    // Links and forms that point at another origin must go through the proxy,
    // and target=_blank must not spawn a window the panel cannot see.
    document.addEventListener(
      'click',
      function (ev) {
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel|sms):/i.test(href)) return;
        var abs;
        try {
          abs = new URL(href, location.href);
        } catch (e) {
          return;
        }
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
        var next = proxify(abs.href);
        if (a.target === '_blank' || a.target === '_new') {
          ev.preventDefault();
          location.href = next;
          return;
        }
        if (next !== abs.href) {
          ev.preventDefault();
          location.href = next;
        }
      },
      true
    );

    document.addEventListener(
      'submit',
      function (ev) {
        var form = ev.target;
        if (!form || !form.getAttribute) return;
        var action = form.getAttribute('action');
        if (!action) return;
        var next = proxify(action);
        if (next !== action) form.setAttribute('action', next);
      },
      true
    );

    var nativeOpen = window.open;
    window.open = function (url) {
      if (url) {
        location.href = proxify(url);
        return window;
      }
      return nativeOpen.apply(this, arguments);
    };
  });

  // ------------------------------------------------- device identity spoofing

  function define(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { get: function () { return value; }, configurable: true });
    } catch (e) {}
  }

  safe('navigator spoof', function () {
    if (PROFILE.ua) define(navigator, 'userAgent', PROFILE.ua);
    if (PROFILE.platform) define(navigator, 'platform', PROFILE.platform);
    if (PROFILE.vendor) define(navigator, 'vendor', PROFILE.vendor);
    if (TOUCH) {
      // 5 is what a real iPhone reports; Chrome DevTools' own default of 1 makes
      // some libraries treat the device as a stylus-only screen.
      define(navigator, 'maxTouchPoints', 5);
      // Feature detection looks on several objects, not just window.
      var targets = [window, document, document.documentElement, document.body];
      var events = ['ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel'];
      targets.forEach(function (target) {
        if (!target) return;
        events.forEach(function (name) {
          if (name in target) return;
          try {
            Object.defineProperty(target, name, { value: null, writable: true, configurable: true });
          } catch (e) {}
        });
      });
    }
  });

  safe('screen spoof', function () {
    var w = PROFILE.width || window.innerWidth;
    var h = PROFILE.height || window.innerHeight;
    define(screen, 'width', w);
    define(screen, 'height', h);
    define(screen, 'availWidth', w);
    define(screen, 'availHeight', h);
    if (PROFILE.dpr) define(window, 'devicePixelRatio', PROFILE.dpr);
    if (PROFILE.orientation) {
      try {
        define(screen, 'orientation', {
          type: PROFILE.orientation === 'landscape' ? 'landscape-primary' : 'portrait-primary',
          angle: PROFILE.orientation === 'landscape' ? 90 : 0,
          addEventListener: function () {},
          removeEventListener: function () {},
        });
      } catch (e) {}
    }
  });

  /*
   * Patch the prototype accessor rather than wrapping matchMedia: it survives
   * MediaQueryList objects created before the shim, reaches ones created later,
   * and keeps the real MediaQueryList identity so brand checks still pass.
   * Chrome normalises the serialisation, so match whitespace-tolerantly.
   */
  var MEDIA_OVERRIDES = [
    [/\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/i, true],
    [/\(\s*(?:any-)?pointer\s*:\s*fine\s*\)/i, false],
    [/\(\s*(?:any-)?hover\s*:\s*hover\s*\)/i, false],
    [/\(\s*(?:any-)?hover\s*:\s*none\s*\)/i, true],
  ];

  safe('matchMedia spoof', function () {
    if (!TOUCH || !window.MediaQueryList) return;
    var proto = window.MediaQueryList.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'matches');
    if (!descriptor || !descriptor.get || !descriptor.configurable) return;
    var nativeGet = descriptor.get;
    Object.defineProperty(proto, 'matches', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function () {
        var query = String(this.media || '');
        for (var i = 0; i < MEDIA_OVERRIDES.length; i++) {
          if (MEDIA_OVERRIDES[i][0].test(query)) return MEDIA_OVERRIDES[i][1];
        }
        return nativeGet.call(this);
      },
    });
  });

  /*
   * Service workers cannot work through the proxy — one registered against the
   * proxy origin would outlive the session and serve stale, rewritten responses
   * back on the next preview.
   */
  safe('service worker stub', function () {
    if (!navigator.serviceWorker) return;
    try {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('Service workers are disabled in Custom AI View.'));
      };
    } catch (e) {}
  });

  // ------------------------------------------------------- touch synthesis

  var gesture = null;

  /**
   * pageX/pageY are what most touch libraries actually read, and screenX/screenY
   * are read by a few; omitting any of them anchors gestures at (0,0). force must
   * be 1 — pressure-gated code reads 0 as "no touch".
   */
  function makeTouch(ev, target, id) {
    return new Touch({
      identifier: id,
      target: target,
      clientX: ev.clientX,
      clientY: ev.clientY,
      screenX: ev.screenX,
      screenY: ev.screenY,
      pageX: ev.clientX + window.scrollX,
      pageY: ev.clientY + window.scrollY,
      radiusX: ev.width ? ev.width / 2 : 11.5,
      radiusY: ev.height ? ev.height / 2 : 11.5,
      rotationAngle: 0,
      force: ev.pressure || 1,
    });
  }

  /**
   * Returns false when the page called preventDefault, which is the signal that it
   * is driving the gesture itself and our drag-scroll must stay out of the way.
   *
   * The target is fixed at touchstart and reused for the whole gesture, including
   * after the pointer leaves the element — that invariant is the browser's job with
   * real touch input and ours here.
   */
  function fireTouch(type, ev, target, id, ending) {
    if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return true;
    var receiver = target && target.dispatchEvent ? target : document.body;
    var touch;
    try {
      touch = makeTouch(ev, receiver, id);
    } catch (e) {
      return true;
    }
    var list = ending ? [] : [touch];
    var event = new TouchEvent(type, {
      touches: list,
      targetTouches: list,
      changedTouches: [touch],
      bubbles: true,
      cancelable: type !== 'touchcancel',
      composed: true, // required to cross shadow boundaries
      view: window,   // libraries read e.view.pageXOffset and crash without it
      altKey: ev.altKey,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      shiftKey: ev.shiftKey,
    });
    return receiver.dispatchEvent(event);
  }

  /*
   * The scroller for each axis, found separately.
   *
   * A horizontal strip — a row of chips, a tab bar, a carousel — is exactly one row
   * tall, so it never satisfies scrollHeight > clientHeight and used to be skipped
   * entirely; the sideways drag went to the page instead and the strip sat still. On
   * a phone your thumb would have moved it, and on a desktop with no touchpad there
   * is no other gesture, so the strip simply could not be scrolled at all.
   *
   * @param {'x'|'y'} axis
   */
  function scrollableAncestor(node, axis) {
    var horizontal = axis === 'x';
    var el = node;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.nodeType === 1) {
        var style = getComputedStyle(el);
        var overflow = horizontal ? style.overflowX : style.overflowY;
        var scrollable = horizontal
          ? el.scrollWidth > el.clientWidth + 1
          : el.scrollHeight > el.clientHeight + 1;
        if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && scrollable) {
          return el;
        }
      }
      el = el.parentNode && el.parentNode.host ? el.parentNode.host : el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /*
   * Stop the drag from painting the page blue.
   *
   * Applied only while a drag is actually scrolling, and lifted afterwards, so
   * selecting text with a deliberate click-and-hold still works the way it does on
   * a phone that has been long-pressed.
   */
  var selectionStyle = null;
  function suppressSelection(on) {
    if (on) {
      if (selectionStyle) return;
      selectionStyle = document.createElement('style');
      selectionStyle.setAttribute('data-custom-ai-view', 'no-select');
      selectionStyle.textContent =
        'html,body,*{-webkit-user-select:none!important;user-select:none!important}';
      (document.head || document.documentElement).appendChild(selectionStyle);
      try {
        var sel = window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      } catch (e) { /* nothing selected */ }
      return;
    }
    if (!selectionStyle) return;
    if (selectionStyle.parentNode) selectionStyle.parentNode.removeChild(selectionStyle);
    selectionStyle = null;
  }

  /*
   * A key press, as a page recognises one.
   *
   * Setting a field's value fires input and change and nothing else, so a form that
   * submits on Enter, a modal that closes on Escape and a field that hands focus on
   * Tab were all unreachable — and plenty of login forms have no button to click
   * instead. keydown/keypress/keyup carry the identifiers listeners actually read,
   * and Enter additionally requests submit() when nothing cancelled it, which is what
   * the browser itself does.
   */
  var KEYS = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  };

  function pressKey(el, name) {
    var spec = KEYS[name] || { key: name, code: name, keyCode: 0 };
    var target = el || document.activeElement || document.body;
    var opts = {
      key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    var live = target.dispatchEvent(new KeyboardEvent('keydown', opts));
    if (live && spec.key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));

    if (live && spec.key === 'Enter') {
      var form = target.form || (target.closest && target.closest('form'));
      if (form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
        } catch (e) {
          try { form.submit(); } catch (e2) { /* the page said no */ }
        }
      }
    }
  }

  function scrollBy(target, dx, dy) {
    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollBy(dx, dy);
    } else {
      target.scrollLeft += dx;
      target.scrollTop += dy;
    }
  }

  safe('touch emulation', function () {
    if (!TOUCH) return;

    window.addEventListener(
      'pointerdown',
      function (ev) {
        if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
        // composedPath pierces shadow DOM, where ev.target is retargeted to the host.
        var path = typeof ev.composedPath === 'function' ? ev.composedPath() : null;
        var target = (path && path[0]) || ev.target;
        stopMomentum();
        gesture = {
          target: target,
          id: ev.pointerId || 1,
          startX: ev.clientX,
          startY: ev.clientY,
          lastX: ev.clientX,
          lastY: ev.clientY,
          moved: 0,
          // One scroller per axis: the strip that moves sideways is rarely the same
          // element as the column that moves up and down.
          scrollerX: scrollableAncestor(target, 'x'),
          scrollerY: scrollableAncestor(target, 'y'),
          pageDriven: false,
          samples: [],
          time: performance.now(),
        };
        // Keep receiving moves once the pointer leaves the element it started on.
        try {
          if (ev.target && ev.target.setPointerCapture) ev.target.setPointerCapture(ev.pointerId);
        } catch (e) {}
        ripple(ev.clientX, ev.clientY);
        var allowed = fireTouch('touchstart', ev, target, gesture.id, false);
        if (!allowed) gesture.pageDriven = true;
      },
      true
    );

    window.addEventListener(
      'pointermove',
      function (ev) {
        if (!gesture || ev.pointerType !== 'mouse') return;
        var dx = ev.clientX - gesture.lastX;
        var dy = ev.clientY - gesture.lastY;
        gesture.moved += Math.abs(dx) + Math.abs(dy);
        gesture.lastX = ev.clientX;
        gesture.lastY = ev.clientY;

        var now = performance.now();
        gesture.samples.push({ dx: dx, dy: dy, t: now });
        if (gesture.samples.length > 6) gesture.samples.shift();

        var allowed = fireTouch('touchmove', ev, gesture.target, gesture.id, false);
        if (!allowed) gesture.pageDriven = true;

        // A real finger scrolls the page. Only do it when the page did not claim
        // the gesture, and only once the movement passes the tap threshold.
        if (!gesture.pageDriven && gesture.moved > 6) {
          if (dx) scrollBy(gesture.scrollerX, -dx, 0);
          if (dy) scrollBy(gesture.scrollerY, 0, -dy);
          // Dragging with a mouse selects text; dragging with a finger does not. The
          // blue smear over half the page was the loudest reminder that this is not
          // really a phone.
          suppressSelection(true);
          ev.preventDefault();
        }
      },
      true
    );

    function endGesture(ev, cancelled) {
      if (!gesture) return;
      var g = gesture;
      gesture = null;
      fireTouch(cancelled ? 'touchcancel' : 'touchend', ev, g.target, g.id, true);
      if (!g.pageDriven && g.moved > 6) {
        startMomentum(g);
        suppressNextClick = true;
      }
    }

    window.addEventListener('pointerup', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      suppressSelection(false);
      endGesture(ev, false);
    }, true);
    window.addEventListener('pointercancel', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      suppressSelection(false);
      endGesture(ev, true);
    }, true);
    window.addEventListener('blur', function () {
      suppressSelection(false);
      gesture = null;
    });

    var suppressNextClick = false;
    window.addEventListener(
      'click',
      function (ev) {
        if (suppressNextClick) {
          suppressNextClick = false;
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );
  });

  // ------------------------------------------------------------- momentum

  var momentumFrame = 0;

  function stopMomentum() {
    if (momentumFrame) cancelAnimationFrame(momentumFrame);
    momentumFrame = 0;
  }

  function startMomentum(g) {
    var recent = g.samples.filter(function (s) {
      return performance.now() - s.t < 80;
    });
    if (!recent.length) return;
    var span = Math.max(16, performance.now() - recent[0].t);
    var vx = 0;
    var vy = 0;
    recent.forEach(function (s) {
      vx += s.dx;
      vy += s.dy;
    });
    vx = (vx / span) * 16;
    vy = (vy / span) * 16;
    if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) return;

    var step = function () {
      // iOS decays a fling by about 0.967 per frame at 60fps. At 0.95 the throw died
      // after roughly two thirds of the distance, which reads as a heavier, stickier
      // page than the one you are actually building.
      vx *= 0.967;
      vy *= 0.967;
      if (vx) scrollBy(g.scrollerX, -vx, 0);
      if (vy) scrollBy(g.scrollerY, 0, -vy);
      if (Math.abs(vx) > 0.15 || Math.abs(vy) > 0.15) momentumFrame = requestAnimationFrame(step);
      else momentumFrame = 0;
    };
    momentumFrame = requestAnimationFrame(step);
  }

  // ----------------------------------------------------------- finger cursor

  /*
   * On a phone you do not have a pointer — you have a fingertip, and it covers
   * about eleven millimetres of glass. An arrow lies about that: it says a tap
   * lands on one pixel, when really it lands on a blob wide enough to hit the
   * neighbouring control. Over a phone or a tablet the arrow is replaced by a
   * circle the size of a real contact patch.
   *
   * Off for Macs and desktops, which genuinely are driven by a mouse.
   */
  var finger = null;
  var fingerStyle = null;

  function pointerMode() {
    if (PROFILE.pointer) return PROFILE.pointer;
    return TOUCH ? 'finger' : 'arrow';
  }

  function ensureFinger() {
    if (finger || pointerMode() === 'arrow') return finger;

    var size = pointerMode() === 'dot' ? 20 : 44;
    finger = document.createElement('div');
    finger.setAttribute('data-custom-ai-view', 'finger');
    finger.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;' +
      'width:' + size + 'px;height:' + size + 'px;margin:' + (-size / 2) + 'px 0 0 ' + (-size / 2) + 'px;' +
      'border-radius:50%;opacity:0;' +
      'background:radial-gradient(circle at 38% 34%, rgba(0,0,0,.20), rgba(0,0,0,.13) 60%, rgba(0,0,0,.06) 100%);' +
      'box-shadow:inset 0 0 0 1px rgba(0,0,0,.16), 0 1px 3px rgba(0,0,0,.18);' +
      'transition:opacity .12s ease;' +
      'transform:translate3d(-200px,-200px,0);will-change:transform;';
    (document.body || document.documentElement).appendChild(finger);

    // Hide the arrow, or two pointers chase each other around the screen.
    fingerStyle = document.createElement('style');
    fingerStyle.setAttribute('data-custom-ai-view', 'finger-css');
    fingerStyle.textContent = 'html,body,*{cursor:none!important}';
    (document.head || document.documentElement).appendChild(fingerStyle);

    return finger;
  }

  function removeFinger() {
    if (finger && finger.parentNode) finger.parentNode.removeChild(finger);
    if (fingerStyle && fingerStyle.parentNode) fingerStyle.parentNode.removeChild(fingerStyle);
    finger = null;
    fingerStyle = null;
  }

  function moveFinger(x, y, pressed) {
    var el = ensureFinger();
    if (!el) return;
    el.style.opacity = '1';
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + (pressed ? 0.82 : 1) + ')';
    el.style.background = pressed
      ? 'radial-gradient(circle at 38% 34%, rgba(0,0,0,.30), rgba(0,0,0,.20) 60%, rgba(0,0,0,.10) 100%)'
      : 'radial-gradient(circle at 38% 34%, rgba(0,0,0,.20), rgba(0,0,0,.13) 60%, rgba(0,0,0,.06) 100%)';
  }

  safe('finger cursor', function () {
    if (pointerMode() === 'arrow') return;
    var pressed = false;

    window.addEventListener('pointermove', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      moveFinger(ev.clientX, ev.clientY, pressed);
    }, true);

    window.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      pressed = true;
      moveFinger(ev.clientX, ev.clientY, true);
    }, true);

    window.addEventListener('pointerup', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      pressed = false;
      moveFinger(ev.clientX, ev.clientY, false);
    }, true);

    // The finger belongs to the phone; off the glass there is no finger.
    document.addEventListener('mouseleave', function () {
      if (finger) finger.style.opacity = '0';
    });
    window.addEventListener('blur', function () {
      pressed = false;
      if (finger) finger.style.opacity = '0';
    });
  });

  // ------------------------------------------------------------ touch ripple

  var rippleLayer = null;

  function ripple(x, y) {
    if (!TOUCH || PROFILE.ripple === false) return;
    safe('ripple', function () {
      if (!rippleLayer) {
        rippleLayer = document.createElement('div');
        rippleLayer.setAttribute('data-custom-ai-view', 'ripple-layer');
        rippleLayer.style.cssText =
          'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
        (document.body || document.documentElement).appendChild(rippleLayer);
      }
      var dot = document.createElement('div');
      dot.style.cssText =
        'position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
        'background:rgba(0,0,0,.16);border:1px solid rgba(0,0,0,.10);' +
        'left:' + x + 'px;top:' + y + 'px;transform:scale(.55);opacity:1;' +
        'transition:transform .38s cubic-bezier(.2,.7,.3,1),opacity .38s ease;';
      rippleLayer.appendChild(dot);
      requestAnimationFrame(function () {
        dot.style.transform = 'scale(1)';
        dot.style.opacity = '0';
      });
      setTimeout(function () {
        if (dot.parentNode) dot.parentNode.removeChild(dot);
      }, 420);
    });
  }

  // ------------------------------------------------- runtime media rewriting

  /*
   * The proxy rewrites interaction media queries in every stylesheet it serves.
   * What it cannot see is CSS generated at runtime — styled-components, emotion,
   * CSS-in-JS, anything inserted through CSSOM after the document was parsed. This
   * walker catches those, and is deliberately a supplement rather than the primary
   * mechanism: doing it here alone would let the desktop hover branch paint first.
   */
  var MEDIA_REWRITES = [
    [/\(\s*(?:any-)?hover\s*:\s*hover\s*\)/gi, '(min-width:999999px)'],
    [/\(\s*(?:any-)?pointer\s*:\s*fine\s*\)/gi, '(min-width:999999px)'],
    [/\(\s*(?:any-)?hover\s*:\s*none\s*\)/gi, '(min-width:0px)'],
    [/\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/gi, '(min-width:0px)'],
  ];

  function rewriteMediaText(text) {
    var out = text;
    for (var i = 0; i < MEDIA_REWRITES.length; i++) {
      out = out.replace(MEDIA_REWRITES[i][0], MEDIA_REWRITES[i][1]);
    }
    return out;
  }

  function walkRules(rules) {
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      try {
        if (rule.media && rule.media.mediaText) {
          var next = rewriteMediaText(rule.media.mediaText);
          if (next !== rule.media.mediaText) rule.media.mediaText = next;
        }
        if (rule.cssRules) walkRules(rule.cssRules);
      } catch (e) { /* cross-origin sheet or immutable rule */ }
    }
  }

  function sweepStyleSheets() {
    safe('media sweep', function () {
      var sheets = [].slice.call(document.styleSheets || []);
      if (document.adoptedStyleSheets) sheets = sheets.concat([].slice.call(document.adoptedStyleSheets));
      sheets.forEach(function (sheet) {
        try {
          walkRules(sheet.cssRules);
        } catch (e) { /* not readable */ }
      });
    });
  }

  safe('runtime media rewriting', function () {
    if (!TOUCH) return;
    sweepStyleSheets();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', sweepStyleSheets);
    }
    window.addEventListener('load', sweepStyleSheets);

    if (!window.MutationObserver) return;
    var pending = 0;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          var name = node.nodeName;
          if (name === 'STYLE' || name === 'LINK' || records[i].type === 'characterData') {
            if (pending) return;
            pending = requestAnimationFrame(function () {
              pending = 0;
              sweepStyleSheets();
            });
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  // ------------------------------------------------------------ mobile CSS

  safe('mobile css', function () {
    var style = document.createElement('style');
    style.setAttribute('data-custom-ai-view', 'mobile-css');
    style.textContent = [
      '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}',
      'html{scrollbar-width:none!important;-ms-overflow-style:none!important;',
      '-webkit-text-size-adjust:100%;text-size-adjust:100%}',
      'html,body{overscroll-behavior:none}',
      '*{-webkit-tap-highlight-color:rgba(0,0,0,.08)}',
      '[data-custom-ai-view]{-webkit-tap-highlight-color:transparent}',
    ].join('');
    var head = document.head || document.documentElement;
    head.appendChild(style);
  });

  // --------------------------------------------------- reporting to the panel

  var lastReported = '';

  function reportUrl() {
    var url = realUrl(location.href);
    if (url === lastReported) return;
    lastReported = url;
    toParent({ type: 'dp:navigated', url: url, title: document.title });
  }

  safe('reporting', function () {
    var pageBackground = function () {
      try {
        var body = document.body;
        var color = body ? getComputedStyle(body).backgroundColor : '';
        if (!color || /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(color)) {
          color = getComputedStyle(document.documentElement).backgroundColor;
        }
        return color;
      } catch (e) {
        return '';
      }
    };

    var announce = function () {
      lastReported = realUrl(location.href);
      toParent({
        type: 'dp:ready',
        url: lastReported,
        title: document.title,
        hasViewport: !!CFG.hasViewport,
        background: pageBackground(),
        scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
        innerWidth: window.innerWidth,
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', announce);
    } else {
      announce();
    }
    window.addEventListener('load', announce);

    var scrollTick = 0;
    window.addEventListener(
      'scroll',
      function () {
        if (scrollTick) return;
        scrollTick = requestAnimationFrame(function () {
          scrollTick = 0;
          toParent({ type: 'dp:scroll', x: window.scrollX, y: window.scrollY });
        });
      },
      { passive: true }
    );

    safe('title observer', function () {
      var title = document.querySelector('title');
      if (!title || !window.MutationObserver) return;
      new MutationObserver(function () {
        toParent({ type: 'dp:title', title: document.title });
      }).observe(title, { childList: true, characterData: true, subtree: true });
    });
  });

  // ------------------------------------------------------- console capture

  /*
   * Forwarded to the panel so an agent can read what the page logged. Without this the
   * console of a framed cross-origin page is completely invisible from outside.
   */
  safe('console capture', function () {
    var LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
    var format = function (args) {
      return Array.prototype.map
        .call(args, function (a) {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch (e) {
            return String(a);
          }
        })
        .join(' ')
        .slice(0, 2000);
    };

    LEVELS.forEach(function (level) {
      var native = console[level];
      if (typeof native !== 'function') return;
      console[level] = function () {
        try {
          toParent({ type: 'dp:console', level: level, text: format(arguments) });
        } catch (e) {}
        return native.apply(console, arguments);
      };
    });

    window.addEventListener('error', function (ev) {
      toParent({
        type: 'dp:console',
        level: 'error',
        text: ev.message || 'script error',
        source: (ev.filename || '') + (ev.lineno ? ':' + ev.lineno : ''),
      });
    });

    window.addEventListener('unhandledrejection', function (ev) {
      var reason = ev.reason;
      toParent({
        type: 'dp:console',
        level: 'error',
        text: 'Unhandled rejection: ' + (reason && reason.stack ? reason.stack : String(reason)),
      });
    });
  });

  // --------------------------------------------------------- element inspector

  /*
   * Hover to outline, click to select. The point is to hand the agent something it can
   * actually reason about: the element's markup, its resolved styles, its box, and
   * where it sits in the tree — not just a screenshot of it.
   */
  var inspector = {
    on: false,
    hovered: null,
    selected: null,
    box: null,
    label: null,
    ring: null,
  };

  var STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'border',
    'border-radius', 'background-color', 'background-image', 'color', 'opacity',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'text-align', 'flex-direction', 'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'overflow', 'z-index', 'box-shadow', 'transform',
    'transition', 'visibility', 'white-space',
  ];

  function ensureOverlay() {
    if (inspector.box) return;
    var mk = function (css) {
      var el = document.createElement('div');
      el.setAttribute('data-custom-ai-view', 'inspector');
      el.style.cssText = css;
      (document.body || document.documentElement).appendChild(el);
      return el;
    };
    inspector.box = mk(
      'position:fixed;pointer-events:none;z-index:2147483646;border:1px solid #2f81f7;' +
      'background:rgba(47,129,247,.14);border-radius:2px;display:none;'
    );
    inspector.label = mk(
      'position:fixed;pointer-events:none;z-index:2147483647;display:none;' +
      'background:#2f81f7;color:#fff;font:600 11px/1.5 ui-monospace,Menlo,monospace;' +
      'padding:2px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);'
    );
    inspector.ring = mk(
      'position:fixed;pointer-events:none;z-index:2147483645;display:none;' +
      'border:2px solid #f97316;border-radius:3px;box-shadow:0 0 0 3px rgba(249,115,22,.25);'
    );
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    var name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) name += '.' + cls.join('.');
    return name;
  }

  /** A selector that is stable enough to re-find the element for a capture. */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (classes.length) part += '.' + classes.slice(0, 2).map(CSS.escape).join('.');
      var parent = node.parentElement;
      if (parent) {
        var siblings = [].filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (node === document.body) break;
    }
    return parts.join(' > ');
  }

  function elementReport(el) {
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var styles = {};
    STYLE_KEYS.forEach(function (k) {
      var v = cs.getPropertyValue(k);
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') styles[k] = v.trim();
    });

    var html = el.outerHTML || '';
    var truncated = html.length > 6000;
    if (truncated) html = html.slice(0, 6000);

    var ancestors = [];
    var node = el.parentElement;
    while (node && ancestors.length < 5 && node !== document.documentElement) {
      ancestors.unshift(describe(node));
      node = node.parentElement;
    }

    return {
      type: 'dp:element',
      name: describe(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: (el.getAttribute('class') || '').trim(),
      selector: selectorFor(el),
      ancestors: ancestors,
      childCount: el.children.length,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      styles: styles,
      html: html,
      truncated: truncated,
      url: realUrl(location.href),
    };
  }

  function place(target, rect) {
    target.style.display = 'block';
    target.style.left = rect.left + 'px';
    target.style.top = rect.top + 'px';
    target.style.width = Math.max(0, rect.width) + 'px';
    target.style.height = Math.max(0, rect.height) + 'px';
  }

  function paintHover(el) {
    ensureOverlay();
    if (!el || el.nodeType !== 1) {
      inspector.box.style.display = 'none';
      inspector.label.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    place(inspector.box, rect);
    inspector.label.style.display = 'block';
    inspector.label.textContent =
      describe(el) + '  ' + Math.round(rect.width) + '×' + Math.round(rect.height);
    var top = rect.top - 22;
    inspector.label.style.top = (top < 2 ? rect.bottom + 4 : top) + 'px';
    inspector.label.style.left = Math.max(2, rect.left) + 'px';
    inspector.label.style.width = 'auto';
    inspector.label.style.height = 'auto';
  }

  function paintSelection() {
    ensureOverlay();
    if (!inspector.selected || !inspector.selected.isConnected) {
      inspector.ring.style.display = 'none';
      return;
    }
    place(inspector.ring, inspector.selected.getBoundingClientRect());
  }

  function setInspect(on) {
    inspector.on = !!on;
    ensureOverlay();
    if (!inspector.on) {
      inspector.box.style.display = 'none';
      inspector.label.style.display = 'none';
      inspector.hovered = null;
    }
    document.documentElement.style.cursor = inspector.on ? 'crosshair' : '';
  }

  safe('inspector', function () {
    document.addEventListener(
      'mousemove',
      function (ev) {
        if (!inspector.on) return;
        var el = ev.target;
        if (el && el.getAttribute && el.getAttribute('data-custom-ai-view')) return;
        if (el === inspector.hovered) return;
        inspector.hovered = el;
        paintHover(el);
      },
      true
    );

    document.addEventListener(
      'click',
      function (ev) {
        if (!inspector.on) return;
        var el = ev.target;
        if (el && el.getAttribute && el.getAttribute('data-custom-ai-view')) return;
        ev.preventDefault();
        ev.stopPropagation();
        inspector.selected = el;
        paintSelection();
        try {
          var report = elementReport(el);
          // The path lets the panel reveal this element in its tree, so clicking in
          // the page and clicking in the tree land on the same row.
          report.path = pathOf(el);
          toParent(report);
        } catch (e) {
          toParent({ type: 'dp:element', error: String(e && e.message) });
        }
      },
      true
    );

    window.addEventListener('scroll', function () {
      if (inspector.on && inspector.hovered) paintHover(inspector.hovered);
      paintSelection();
    }, { passive: true });

    window.addEventListener('resize', function () {
      if (inspector.on && inspector.hovered) paintHover(inspector.hovered);
      paintSelection();
    });
  });

  // ----------------------------------------------------------- find & edit

  /*
   * Searching and editing the live page.
   *
   * Everything is addressed by CSS selector or by visible text, and every change is
   * applied to the document that is actually on screen — so an edit shows up in the
   * frame the moment it lands, and a screenshot taken after it shows the change.
   */
  function findMatches(query) {
    var out = [];
    var limit = Math.min(query.limit || 20, 100);

    if (query.selector) {
      var list;
      try {
        list = document.querySelectorAll(query.selector);
      } catch (e) {
        return { error: 'Bad selector: ' + e.message };
      }
      for (var i = 0; i < list.length && out.length < limit; i++) out.push(list[i]);
    } else if (query.text) {
      var needle = String(query.text).toLowerCase();
      var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode()) && out.length < limit) {
        if (node.getAttribute && node.getAttribute('data-custom-ai-view')) continue;
        // The element that *owns* the text, not every ancestor containing it.
        var own = '';
        for (var c = 0; c < node.childNodes.length; c++) {
          if (node.childNodes[c].nodeType === 3) own += node.childNodes[c].nodeValue;
        }
        if (own.toLowerCase().indexOf(needle) >= 0) out.push(node);
      }
    } else {
      return { error: 'Give either a selector or some text to look for.' };
    }

    return {
      matches: out.map(function (el) {
        var r = el.getBoundingClientRect();
        return {
          name: describe(el),
          selector: selectorFor(el),
          path: pathOf(el),
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          visible: isReallyVisible(el, r),
          offscreen: r.width > 0 && r.height > 0 && !intersectsViewport(r),
        };
      }),
    };
  }

  function intersectsViewport(r) {
    var w = window.innerWidth || 0;
    var h = window.innerHeight || 0;
    return r.bottom > 0 && r.right > 0 && r.top < h && r.left < w;
  }

  /*
   * Visible as a person would mean it.
   *
   * "Has a width and a height" called a great many things visible that nobody could
   * see or tap: a carousel's offscreen duplicates parked at x = -1925, a sheet caught
   * mid-animation at opacity 0, anything under visibility:hidden. Reporting those as
   * visible is how a tap gets aimed at a copy of the button rather than the button,
   * and the answer still reads like success.
   */
  function isReallyVisible(el, r) {
    if (!(r.width > 0 && r.height > 0)) return false;
    if (!intersectsViewport(r)) return false;
    var style;
    try {
      style = getComputedStyle(el);
    } catch (e) {
      return true;
    }
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  /** Apply a change and report what it replaced, so it can be reasoned about. */
  function editElement(spec) {
    var el;
    try {
      el = spec.selector ? document.querySelector(spec.selector) : inspector.selected;
    } catch (e) {
      return { error: 'Bad selector: ' + e.message };
    }
    if (!el) return { error: 'Nothing matched ' + (spec.selector || '(no selection)') };

    var before = { style: {}, text: null, attrs: {} };
    var changed = [];

    if (spec.style) {
      Object.keys(spec.style).forEach(function (prop) {
        before.style[prop] = el.style.getPropertyValue(prop) || '';
        // setProperty takes the dashed form; camelCase would be silently ignored.
        var dashed = prop.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
        el.style.setProperty(dashed, String(spec.style[prop]));
        changed.push(dashed);
      });
    }

    if (typeof spec.text === 'string') {
      before.text = el.textContent;
      el.textContent = spec.text;
      changed.push('text');
    }

    if (typeof spec.html === 'string') {
      before.html = el.innerHTML.slice(0, 2000);
      el.innerHTML = spec.html;
      changed.push('html');
    }

    if (spec.attrs) {
      Object.keys(spec.attrs).forEach(function (name) {
        before.attrs[name] = el.getAttribute(name);
        if (spec.attrs[name] === null) el.removeAttribute(name);
        else el.setAttribute(name, String(spec.attrs[name]));
        changed.push('@' + name);
      });
    }

    if (spec.addClass) {
      String(spec.addClass).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList.add(c); });
      changed.push('+class');
    }
    if (spec.removeClass) {
      String(spec.removeClass).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList.remove(c); });
      changed.push('-class');
    }

    if (spec.remove) {
      before.outerHTML = el.outerHTML.slice(0, 2000);
      el.remove();
      changed.push('removed');
      return { ok: true, name: describe(el), changed: changed, before: before, gone: true };
    }

    paintSelection();
    var rect = el.getBoundingClientRect();
    return {
      ok: true,
      name: describe(el),
      selector: selectorFor(el),
      changed: changed,
      before: before,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  }

  /*
   * Replay the edits that were made before this load.
   *
   * A single pass at DOMContentLoaded is not enough: on anything that renders
   * client-side the target element does not exist yet. So the edits are re-applied
   * whenever the DOM changes, until each one has landed or a grace period expires —
   * after which watching costs more than it is worth.
   */
  safe('replay edits', function () {
    var pending = (CFG.edits || []).slice();
    if (!pending.length) return;

    // Tell the panel, so it can say out loud that this page is not what the site
    // served — an invisible override is a trap.
    toParent({ type: 'dp:edits-active', count: pending.length });

    var applied = Object.create(null);

    function attempt() {
      var stillWaiting = false;
      pending.forEach(function (edit, i) {
        if (applied[i]) return;
        var el;
        try {
          el = document.querySelector(edit.selector);
        } catch (e) {
          applied[i] = true; // a selector that cannot parse will never match
          return;
        }
        if (!el) {
          stillWaiting = true;
          return;
        }
        editElement(edit);
        applied[i] = true;
      });
      return stillWaiting;
    }

    var stop = function () {
      if (observer) observer.disconnect();
      observer = null;
    };

    var observer = null;
    var frame = 0;

    var run = function () {
      if (!attempt()) stop();
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
    window.addEventListener('load', run);

    if (window.MutationObserver) {
      observer = new MutationObserver(function () {
        if (frame) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          run();
        });
      });
      var start = function () {
        if (!observer || !document.documentElement) return;
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // Long enough for a client-rendered app to settle, short enough not to
        // fight the page for the rest of its life.
        setTimeout(stop, 15000);
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start);
    }
  });

  // ------------------------------------------------------------- DOM tree

  /*
   * The element tree the panel draws.
   *
   * Nodes are addressed by a path of child indices from <html> rather than by a CSS
   * selector: a selector can be ambiguous or unbuildable, while a path is exact and
   * survives being sent across the frame boundary as plain JSON. Children are sent
   * one level at a time, so opening a page with fifty thousand nodes costs nothing
   * until you actually expand into it.
   */
  function elementChildren(el) {
    return el ? [].filter.call(el.children, function (c) {
      // The inspector's own overlays are not part of the page.
      return !c.hasAttribute || !c.hasAttribute('data-custom-ai-view');
    }) : [];
  }

  function nodeAt(path) {
    var el = document.documentElement;
    for (var i = 0; i < (path || []).length; i++) {
      var kids = elementChildren(el);
      el = kids[path[i]];
      if (!el) return null;
    }
    return el;
  }

  function pathOf(el) {
    var path = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var parent = node.parentElement;
      if (!parent) return null;
      var index = elementChildren(parent).indexOf(node);
      if (index < 0) return null;
      path.unshift(index);
      node = parent;
    }
    return node === document.documentElement ? path : null;
  }

  /** One row of the tree: enough to draw it, not enough to be expensive. */
  function nodeSummary(el, path) {
    var kids = elementChildren(el);
    var classes = (el.getAttribute && el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    var ownText = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) ownText += el.childNodes[i].nodeValue;
    }
    var rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: classes.slice(0, 4),
      path: path,
      kids: kids.length,
      text: ownText.trim().replace(/\s+/g, ' ').slice(0, 60),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      hidden: rect.width === 0 && rect.height === 0,
    };
  }

  function sendTree(path) {
    var el = nodeAt(path);
    if (!el) {
      toParent({ type: 'dp:tree', path: path, children: [], error: 'gone' });
      return;
    }
    var kids = elementChildren(el);
    var children = [];
    // A wall of ten thousand siblings helps nobody; the panel says how many were cut.
    var limit = Math.min(kids.length, 300);
    for (var i = 0; i < limit; i++) {
      children.push(nodeSummary(kids[i], (path || []).concat([i])));
    }
    toParent({
      type: 'dp:tree',
      path: path || [],
      children: children,
      truncated: kids.length - limit,
      root: (path || []).length === 0 ? nodeSummary(el, []) : null,
    });
  }

  // ------------------------------------------------------- storage purge

  /**
   * Wipe everything the previewed page has stored on the proxy origin. An extension
   * cannot flush Chromium's own HTTP cache, but combined with the proxy's revalidate
   * headers this is a genuine "start from nothing" for the site.
   */
  function purgeStorage() {
    var cleared = [];
    var jobs = [];

    try {
      localStorage.clear();
      cleared.push('localStorage');
    } catch (e) {}
    try {
      sessionStorage.clear();
      cleared.push('sessionStorage');
    } catch (e) {}

    try {
      document.cookie.split(';').forEach(function (part) {
        var name = part.split('=')[0].trim();
        if (!name) return;
        document.cookie = name + '=; Max-Age=0; path=/';
        document.cookie = name + '=; Max-Age=0; path=' + location.pathname;
      });
      cleared.push('cookies');
    } catch (e) {}

    if (window.caches && caches.keys) {
      jobs.push(
        caches
          .keys()
          .then(function (keys) {
            cleared.push('caches(' + keys.length + ')');
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          })
          .catch(function () {})
      );
    }

    if (window.indexedDB && indexedDB.databases) {
      jobs.push(
        indexedDB
          .databases()
          .then(function (dbs) {
            cleared.push('indexedDB(' + dbs.length + ')');
            return Promise.all(
              dbs.map(function (db) {
                return new Promise(function (resolve) {
                  if (!db.name) return resolve();
                  var req = indexedDB.deleteDatabase(db.name);
                  req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
                });
              })
            );
          })
          .catch(function () {})
      );
    }

    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(
        navigator.serviceWorker
          .getRegistrations()
          .then(function (regs) {
            if (regs.length) cleared.push('serviceWorkers(' + regs.length + ')');
            return Promise.all(regs.map(function (r) { return r.unregister(); }));
          })
          .catch(function () {})
      );
    }

    return Promise.all(jobs).then(function () {
      return cleared;
    });
  }

  // ------------------------------------------------- commands from the panel

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'dp:cmd:reload':
        location.reload();
        break;
      case 'dp:cmd:back':
        history.back();
        break;
      case 'dp:cmd:forward':
        history.forward();
        break;
      case 'dp:cmd:top':
        window.scrollTo({ top: 0, behavior: data.smooth ? 'smooth' : 'auto' });
        break;
      case 'dp:cmd:navigate':
        if (data.url) location.href = proxify(data.url);
        break;
      case 'dp:cmd:inspect':
        setInspect(data.on);
        break;
      case 'dp:cmd:clear-selection':
        inspector.selected = null;
        paintSelection();
        break;
      case 'dp:cmd:highlight':
        // Used by the capture page so the ring is baked into the screenshot.
        safe('highlight', function () {
          var el = data.selector ? document.querySelector(data.selector) : null;
          inspector.selected = el;
          paintSelection();
        });
        break;
      case 'dp:cmd:input':
        /*
         * Input driven from outside, by selector rather than by coordinates: the
         * page is scaled and offset inside the device frame, so window coordinates
         * mean nothing here — a selector is the only stable address.
         */
        safe('remote input', function () {
          var el = data.selector ? document.querySelector(data.selector) : null;
          if (data.kind === 'scroll') {
            var target = el || window;
            if (target === window) window.scrollBy(data.dx || 0, data.dy || 0);
            else target.scrollBy(data.dx || 0, data.dy || 0);
            toParent({ type: 'dp:input-done', rid: data.rid, kind: 'scroll' });
            return;
          }
          // A keystroke without a selector goes where a keystroke goes: to whatever
          // has focus. Everything else still needs to be told what to act on.
          if (!el && data.kind === 'key') el = document.activeElement || document.body;
          if (!el) {
            toParent({ type: 'dp:input-done', rid: data.rid, error: 'No element matched ' + data.selector });
            return;
          }
          if (data.kind === 'click') {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            var rect = el.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
              var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
              el.dispatchEvent(new Ctor(type, type.indexOf('pointer') === 0
                ? Object.assign({ pointerId: 1, pointerType: 'touch', isPrimary: true }, opts)
                : opts));
            });
            if (typeof el.focus === 'function') el.focus();
            toParent({ type: 'dp:input-done', rid: data.rid, kind: 'click', name: describe(el) });
            return;
          }
          if (data.kind === 'type') {
            if (typeof el.focus === 'function') el.focus();
            var setter = Object.getOwnPropertyDescriptor(
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              'value'
            );
            // React and friends listen to the native setter, not to el.value = x.
            if (setter && setter.set) setter.set.call(el, data.text);
            else if ('value' in el) el.value = data.text;
            else el.textContent = data.text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // A form that submits on Enter cannot be submitted without one, and a
            // great many login forms have no button to press instead.
            if (data.key) pressKey(el, data.key);
            toParent({ type: 'dp:input-done', rid: data.rid, kind: 'type', name: describe(el) });
            return;
          }
          if (data.kind === 'key') {
            if (typeof el.focus === 'function') el.focus();
            pressKey(el, data.key || 'Enter');
            toParent({
              type: 'dp:input-done', rid: data.rid, kind: 'key',
              name: (data.key || 'Enter') + ' on ' + describe(el),
            });
          }
        });
        break;
      case 'dp:cmd:ready':
        // Cheap enough to poll every quarter second: has the document finished, and
        // is anything still visibly in flight.
        safe('ready', function () {
          toParent({
            type: 'dp:ready-state',
            rid: data.rid,
            readyState: document.readyState,
            pendingImages: Array.prototype.filter.call(document.images || [], function (img) {
              return !img.complete;
            }).length,
          });
        });
        break;
      case 'dp:cmd:html':
        safe('html', function () {
          var doc = document.documentElement ? document.documentElement.outerHTML : '';
          toParent({
            type: 'dp:html',
            rid: data.rid,
            // Big enough for any real page, bounded so a runaway document cannot
            // wedge the message channel.
            html: doc.slice(0, 4 * 1024 * 1024),
            truncated: doc.length > 4 * 1024 * 1024,
            url: realUrl(location.href),
            title: document.title,
          });
        });
        break;
      case 'dp:cmd:pointer':
        safe('pointer mode', function () {
          PROFILE.pointer = data.mode || 'finger';
          removeFinger();
          if (PROFILE.pointer !== 'arrow') ensureFinger();
        });
        break;
      case 'dp:cmd:find':
        safe('find', function () {
          var result = findMatches(data);
          toParent(Object.assign({ type: 'dp:found', rid: data.rid }, result));
        });
        break;
      case 'dp:cmd:edit':
        safe('edit', function () {
          var result = editElement(data);
          toParent(Object.assign({ type: 'dp:edited', rid: data.rid }, result));
        });
        break;
      case 'dp:cmd:tree':
        safe('tree', function () {
          sendTree(data.path || []);
        });
        break;
      case 'dp:cmd:hover-path':
        safe('hover path', function () {
          // Hovering a row in the panel outlines the element in the page.
          if (!data.path) {
            ensureOverlay();
            inspector.box.style.display = 'none';
            inspector.label.style.display = 'none';
            toParent({ type: 'dp:hovered', path: null, ok: true });
            return;
          }
          var el = nodeAt(data.path);
          if (!el) {
            toParent({ type: 'dp:hovered', path: data.path, ok: false });
            return;
          }
          paintHover(el);
          var r = el.getBoundingClientRect();
          toParent({
            type: 'dp:hovered',
            path: data.path,
            ok: true,
            name: describe(el),
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          });
        });
        break;
      case 'dp:cmd:select-path':
        safe('select path', function () {
          var el = nodeAt(data.path || []);
          if (!el) return;
          if (data.scroll !== false) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          inspector.selected = el;
          paintSelection();
          var report = elementReport(el);
          report.path = data.path || [];
          toParent(report);
        });
        break;
      case 'dp:cmd:describe':
        safe('describe', function () {
          var el = data.selector ? document.querySelector(data.selector) : inspector.selected;
          if (!el) {
            toParent({ type: 'dp:described', error: 'No element matched ' + (data.selector || '(no selection)') });
            return;
          }
          var report = elementReport(el);
          report.type = 'dp:described';
          toParent(report);
        });
        break;
      case 'dp:cmd:locate':
        safe('locate', function () {
          var el = data.selector ? document.querySelector(data.selector) : null;
          if (!el) return toParent({ type: 'dp:located', rect: null });
          var r = el.getBoundingClientRect();
          toParent({
            type: 'dp:located',
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          });
        });
        break;
      case 'dp:cmd:purge':
        purgeStorage().then(function (cleared) {
          toParent({ type: 'dp:purged', cleared: cleared });
        });
        break;
      case 'dp:cmd:profile':
        if (data.profile) {
          PROFILE = Object.assign(PROFILE, data.profile);
          TOUCH = PROFILE.touch !== false;
        }
        break;
      default:
        break;
    }
  });
})();
