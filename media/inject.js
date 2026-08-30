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

  /* ------------------------------------------------------ storage, per site
   *
   * Every previewed site is served from one origin with the real one encoded in
   * the path. That is what keeps a login alive across restarts — and what puts
   * every site's localStorage in the same bucket. Two sites both keeping a
   * `token`, a `user` or a `theme` overwrite each other; one can read the
   * other's; and clearing storage for the site in front of you wiped the logins
   * of every site ever previewed, which is the opposite of what the cookie
   * renaming exists to protect.
   *
   * So each site's keys carry its own origin as a prefix, and the prefix is
   * hidden from the page. A page cannot tell it is sharing and cannot reach
   * anything that is not its own.
   *
   * It is a real Storage — length, key(), the named methods, and index access
   * through a Proxy, because pages do write `store.token` and read
   * `Object.keys(store)`. Where it cannot be installed the shared bucket
   * remains: a page with no storage at all is a worse failure than the leak.
   */
  var STORE_PREFIX = (function () {
    try {
      var m = location.pathname.match(/^\/[0-9a-f]+\/([A-Za-z0-9_-]+)(\/|$)/);
      // A NUL on each side, written out rather than typed: no page writes a key
      // containing one, so a site's keys can never be confused with the prefix,
      // and the separator cannot collide with anything real.
      // A NUL on each side, written out rather than typed. No page writes a key
      // containing one, so a site's keys can never be mistaken for the prefix and
      // the separator cannot collide with anything real. Typed literally it also
      // makes this file read as binary to every tool that looks at it.
      // A NUL each side, written as an escape rather than typed. No page writes a
      // key containing one, so a site's keys can never be mistaken for the prefix
      // and the separator cannot collide with anything real — but a literal NUL in
      // the source makes this file read as binary to every tool that opens it.
      return m ? '\u0000' + m[1] + '\u0000' : null;
    } catch (e) {
      return null;
    }
  })();

  function namespaced(real) {
    var P = STORE_PREFIX;
    var mine = function () {
      var out = [];
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i);
        if (k && k.indexOf(P) === 0) out.push(k.slice(P.length));
      }
      return out;
    };
    var api = {
      get length() { return mine().length; },
      key: function (n) { var k = mine(); return n >= 0 && n < k.length ? k[n] : null; },
      getItem: function (k) { return real.getItem(P + k); },
      setItem: function (k, v) { return real.setItem(P + k, v); },
      removeItem: function (k) { return real.removeItem(P + k); },
      clear: function () { mine().forEach(function (k) { real.removeItem(P + k); }); },
      // Not part of Storage: a way to see what belongs to the site in front of
      // you without walking the whole shared bucket.
      __ownKeys: mine,
    };
    if (typeof Proxy !== 'function') return api;
    return new Proxy(api, {
      get: function (t, prop) {
        if (prop in t) return typeof t[prop] === 'function' ? t[prop].bind(t) : t[prop];
        if (typeof prop === 'symbol') return undefined;
        return real.getItem(P + prop);
      },
      set: function (t, prop, value) {
        if (prop in t) return true;
        real.setItem(P + prop, String(value));
        return true;
      },
      has: function (t, prop) { return prop in t || real.getItem(P + prop) !== null; },
      deleteProperty: function (t, prop) { real.removeItem(P + prop); return true; },
      ownKeys: function () { return mine(); },
      getOwnPropertyDescriptor: function (t, prop) {
        if (prop in t) return Object.getOwnPropertyDescriptor(t, prop);
        var v = real.getItem(P + prop);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
    });
  }

  var STORES = {};
  safe('storage namespace', function () {
    if (!STORE_PREFIX) return;
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var real;
      try { real = window[name]; } catch (e) { return; }   // blocked by policy
      if (!real) return;
      var shim = namespaced(real);
      STORES[name] = { real: real, shim: shim };
      try {
        Object.defineProperty(window, name, { value: shim, configurable: true, writable: false });
      } catch (e) {
        /* a browser that will not let it be replaced keeps the shared bucket */
      }
    });
  });

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
  /*
   * Every root, not just the document.
   *
   * querySelectorAll stops at a shadow boundary, and so does a TreeWalker. A
   * page built out of custom elements — which is most design systems, and every
   * Salesforce, Shoelace or Ionic app — therefore looked empty: find returned
   * nothing, the outline listed a handful of wrappers, and there was no way to
   * reach a single control inside them.
   *
   * Only open roots can be entered. A closed root is genuinely unreachable from
   * script, so it is counted and reported rather than passed over in silence:
   * "nothing found" and "nothing found that anything can reach" are different
   * answers.
   */
  function eachRoot(fn) {
    var closed = 0;
    var seen = 0;
    var walk = function (root) {
      if (seen++ > 400) return;                 // a page cannot be all shadow
      fn(root);
      var hosts = root.querySelectorAll('*');
      for (var i = 0; i < hosts.length; i++) {
        var sr = hosts[i].shadowRoot;
        if (sr) walk(sr);
        else if (hosts[i].attachShadow && hosts[i].tagName.indexOf('-') > 0
          && !hosts[i].children.length && hosts[i].textContent === '') closed++;
      }
    };
    walk(document);
    return closed;
  }

  /** Elements whose text is source code, not words on a screen. */
  var NOT_TEXT = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1, HEAD: 1, META: 1, LINK: 1,
  };

  /*
   * Resolve a selector anywhere it can be reached.
   *
   * document.querySelector stops at the first shadow boundary, so a control
   * that find had just reported could not then be clicked, typed into or
   * inspected — the selector came back and then matched nothing. Every place
   * that turns a selector into an element goes through here instead.
   */
  function pick(selector) {
    if (!selector) return null;
    var found = null;
    try {
      found = document.querySelector(selector);
    } catch (e) {
      return null;                              // an invalid selector matches nothing
    }
    if (found) return found;
    eachRoot(function (root) {
      if (found || root === document) return;
      try {
        found = root.querySelector(selector) || found;
      } catch (e) { /* already known to parse; a root may still refuse it */ }
    });
    return found;
  }

  function findMatches(query) {
    var out = [];
    var limit = Math.min(query.limit || 20, 100);
    var closedRoots = 0;

    if (query.selector) {
      var bad = null;
      closedRoots = eachRoot(function (root) {
        if (bad || out.length >= limit) return;
        var list;
        try {
          list = root.querySelectorAll(query.selector);
        } catch (e) {
          bad = 'Bad selector: ' + e.message;
          return;
        }
        for (var i = 0; i < list.length && out.length < limit; i++) out.push(list[i]);
      });
      if (bad) return { error: bad };
    } else if (query.text) {
      var needle = String(query.text).toLowerCase();
      closedRoots = eachRoot(function (root) {
        if (out.length >= limit) return;
        var from = root === document ? (document.body || document.documentElement) : root;
        if (!from) return;
        var walker = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode()) && out.length < limit) {
          if (node.getAttribute && node.getAttribute('data-custom-ai-view')) continue;
          // A <script> whose source happens to contain the words is not what
          // anyone is looking for. On a page built from custom elements the
          // script that defines them holds every string on the screen, so it
          // matched first, every time, and the real element was never reached.
          if (NOT_TEXT[node.tagName]) continue;
          // The element that *owns* the text, not every ancestor containing it.
          var own = '';
          for (var c = 0; c < node.childNodes.length; c++) {
            if (node.childNodes[c].nodeType === 3) own += node.childNodes[c].nodeValue;
          }
          if (own.toLowerCase().indexOf(needle) >= 0) out.push(node);
        }
      });
    } else {
      return { error: 'Give either a selector or some text to look for.' };
    }

    return {
      closedRoots: closedRoots,
      matches: out.map(function (el) {
        var r = el.getBoundingClientRect();
        // An element inside a shadow root cannot be addressed by a selector from
        // the document, so saying which root it is in is the difference between
        // a match that can be acted on and one that only looks like it can.
        var root = el.getRootNode ? el.getRootNode() : document;
        var shadow = root !== document && root.host ? describe(root.host) : null;
        return {
          name: describe(el),
          selector: selectorFor(el),
          path: pathOf(el),
          shadowHost: shadow,
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
    return !hiddenByStyle(el);
  }

  /**
   * The half of "can it be seen" that needs no geometry, so it can also be asked
   * about an element that is off screen rather than hidden.
   */
  function hiddenByStyle(el) {
    var style;
    try {
      style = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.display === 'none') return true;
    if (parseFloat(style.opacity) === 0) return true;
    return false;
  }

  /** Apply a change and report what it replaced, so it can be reasoned about. */
  function editElement(spec) {
    var el;
    try {
      el = spec.selector ? pick(spec.selector) : inspector.selected;
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
          el = pick(edit.selector);
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

  // ---------------------------------------------------------- page outline

  /*
   * What is on the page, for something that cannot look at it.
   *
   * Every other tool here wants the answer before it will take the question: find,
   * click, type and inspect all begin with a selector. Working out what those
   * selectors are meant photographing the page and reading the pixels — an image
   * per look, and a guess at the markup behind them. This walks the document once
   * and reports the parts a person can see and use: what each one is, what it is
   * called, and an address the other tools take verbatim.
   *
   * Being small is the feature, not a compromise. A dump of every node is what makes
   * the other snapshots unusable — they cost more of the context window than the
   * screenshot they replaced, and the one row worth reading is buried under four
   * hundred wrappers. So: nothing invisible, nothing that cannot be used or read, a
   * hard cap, and a count of what the cap threw away. A silent truncation is how an
   * agent concludes a button does not exist.
   */

  var OUTLINE_PRUNE = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, LINK: 1, META: 1, TITLE: 1,
    // An <option> is not something a finger can reach — the <select> is, and it
    // carries its options with it. An icon drawn as forty <path> elements is forty
    // rows of nothing.
    OPTION: 1, OPTGROUP: 1, SVG: 1, CANVAS: 1,
  };

  var TAG_ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'summary',
    IMG: 'image', IFRAME: 'frame', VIDEO: 'video', AUDIO: 'audio', DIALOG: 'dialog',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', FORM: 'form', SEARCH: 'search',
  };

  var INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file', color: 'color',
    submit: 'button', button: 'button', reset: 'button', image: 'button', search: 'searchbox',
  };

  /*
   * Worth a row even with no name: an unnamed control is still something an agent
   * can tap, and it is usually a bug worth seeing rather than a row worth hiding.
   */
  var CONTROL_ROLES = {
    link: 1, button: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, textbox: 1, searchbox: 1,
    combobox: 1, listbox: 1, slider: 1, spinbutton: 1, file: 1, color: 1, summary: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1, focusable: 1,
  };

  /*
   * Structure and the things that are neither a control nor prose. A handful per
   * page, and they are what says which of the four boxes called "Search" is the one
   * in the header.
   */
  var STRUCTURE_ROLES = {
    navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1,
    search: 1, region: 1, dialog: 1, alert: 1, status: 1, tablist: 1, menu: 1, list: 1,
    image: 1, frame: 1, video: 1, audio: 1,
  };

  var HEADING_ROLE = /^h[1-6]$/;

  // Deep enough for any real page; a guard against a document that never ends.
  var OUTLINE_SCAN_CAP = 4000;

  function collapse(text, cap) {
    var out = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return out.length > cap ? out.slice(0, cap - 1) + '…' : out;
  }

  /** The text an element owns, as opposed to the text of everything inside it. */
  function ownText(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].nodeValue;
    }
    return out;
  }

  /**
   * display:none and content-visibility:hidden — the part of "hidden" that a child
   * cannot undo, which is what makes it safe to skip the whole subtree.
   */
  function notRendered(el) {
    if (el.checkVisibility) return !el.checkVisibility();
    try {
      return getComputedStyle(el).display === 'none';
    } catch (e) {
      return false;
    }
  }

  /*
   * Faded out by something above it.
   *
   * An element's own opacity is 1 while the sheet it sits in is halfway through its
   * fade, so asking it directly gets "perfectly visible" about something nobody can
   * see — the same class of lie as the carousel's spare copy parked off the left
   * edge. checkVisibility can see the ancestors. Its option names were standardised
   * after Chrome shipped the first pair, so both spellings go in and the browser
   * reads whichever it knows.
   */
  function fadedOut(el) {
    if (!el.checkVisibility) return false;
    return !el.checkVisibility({
      opacityProperty: true, visibilityProperty: true,
      checkOpacity: true, checkVisibilityCSS: true,
    });
  }

  /*
   * Inside the page, as opposed to parked outside it. Used when the whole scrollable
   * document is being outlined, where "on screen" is not the question — but a
   * carousel's duplicate slide at x = -1925 and a drawer that lives one screen off
   * the right edge are still nothing a person will ever scroll to.
   */
  function intersectsDocument(r) {
    var doc = document.documentElement;
    var w = Math.max(doc ? doc.scrollWidth : 0, window.innerWidth || 0);
    var h = Math.max(doc ? doc.scrollHeight : 0, window.innerHeight || 0);
    var left = r.left + (window.scrollX || 0);
    var top = r.top + (window.scrollY || 0);
    return left + r.width > 0 && top + r.height > 0 && left < w && top < h;
  }

  function roleOf(el) {
    var explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    // A page that says "this is decoration" is telling the truth about itself.
    if (explicit === 'presentation' || explicit === 'none') return '';
    if (explicit === 'heading') return 'h' + (parseInt(el.getAttribute('aria-level'), 10) || 2);
    if (explicit) return explicit;

    var tag = el.tagName;
    if (HEADING_ROLE.test(tag.toLowerCase())) return tag.toLowerCase();
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      return INPUT_ROLES[type] || 'textbox';
    }
    // An anchor with no href is not a link; it is a bookmark target.
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    var editable = el.getAttribute('contenteditable');
    if (editable === '' || editable === 'true') return 'textbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return 'region';
    /*
     * A div with a tabindex is a button somebody built out of a div. It answers to a
     * tap and to Enter, and without this it is invisible to everything here — which
     * on an older application is most of the interface.
     */
    var tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && parseInt(tabindex, 10) >= 0) return 'focusable';
    return '';
  }

  function kindOf(role) {
    if (!role) return '';
    if (HEADING_ROLE.test(role) || CONTROL_ROLES[role]) return 'control';
    if (STRUCTURE_ROLES[role]) return 'structure';
    return '';
  }

  /*
   * The name a screen reader would read out, near enough.
   *
   * The real algorithm is a specification of its own; this is the part of it that
   * decides what a person calls the thing, in the order the browser resolves it.
   * Being wrong in the cheap direction — falling back to textContent on a wrapper —
   * is how an outline ends up quoting the entire page as the name of one <div>, so
   * text is only ever taken from something that is itself a control or a heading.
   */
  function accessibleName(el, role) {
    var label = el.getAttribute('aria-label');
    if (label && label.trim()) return collapse(label, 80);

    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var joined = by.trim().split(/\s+/).map(function (id) {
        var target = document.getElementById(id);
        return target ? target.textContent : '';
      }).join(' ');
      if (joined.trim()) return collapse(joined, 80);
    }

    var tag = el.tagName;
    if (tag === 'IMG') return collapse(el.getAttribute('alt') || el.getAttribute('title') || '', 80);

    // The <label> the browser itself associates, which covers both for="" and
    // wrapping — guessing at either got the wrong one often enough to matter.
    if (el.labels && el.labels.length) {
      var associated = collapse(el.labels[0].textContent, 80);
      if (associated) return associated;
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      var placeholder = el.getAttribute('placeholder') || el.getAttribute('title') || '';
      if (placeholder.trim()) return collapse(placeholder, 80);
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return collapse(el.value, 80);
      return '';
    }

    if (role && (HEADING_ROLE.test(role) || CONTROL_ROLES[role])) {
      var spoken = collapse(el.textContent, 80);
      if (spoken) return spoken;
    }

    var title = el.getAttribute('title');
    return title && title.trim() ? collapse(title, 80) : '';
  }

  /** What the control is currently holding, and what a person can tell about it. */
  function outlineValue(el, role) {
    var tag = el.tagName;
    if (tag === 'SELECT') {
      var chosen = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return chosen ? collapse(chosen.textContent, 40) : '';
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Never the value of a password field. It goes to a log file and to a model.
      if ((el.getAttribute('type') || '').toLowerCase() === 'password') return el.value ? '••••' : '';
      if (role === 'checkbox' || role === 'radio' || role === 'file') return '';
      return collapse(el.value, 40);
    }
    if (el.isContentEditable) return collapse(ownText(el), 40);
    // An unnamed link is only identifiable by where it goes, and it costs nothing
    // to say so for the handful of them that exist.
    if (role === 'link' && !accessibleName(el, role)) {
      try {
        return collapse(new URL(realUrl(el.href)).pathname, 40);
      } catch (e) {
        return '';
      }
    }
    return '';
  }

  function outlineState(el) {
    var state = [];
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') state.push('disabled');
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') state.push('checked');
    if (el.getAttribute('aria-selected') === 'true') state.push('selected');
    var expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') state.push('expanded');
    else if (expanded === 'false') state.push('collapsed');
    var current = el.getAttribute('aria-current');
    if (current && current !== 'false') state.push('current');
    if (el.tagName === 'SELECT' && el.options) state.push(el.options.length + ' options');
    return state;
  }

  /**
   * An address the other tools will accept, checked before it is handed over.
   *
   * selectorFor builds a readable chain and gives up after six levels, so on a deep
   * page the top of the chain floats free: `li:nth-of-type(3) > a` matches inside
   * every list on the page, and the first match is rarely the one being described. A
   * reference that resolves to something else is worse than no reference at all —
   * the tap lands elsewhere and reports success. So the readable form is offered
   * first and verified, and anything ambiguous falls back to an exact :nth-child
   * path anchored at the nearest ancestor that is not.
   */
  function resolvesTo(selector, el) {
    try {
      return !!selector && document.querySelector(selector) === el;
    } catch (e) {
      return false;
    }
  }

  function refFor(el) {
    var readable = selectorFor(el);
    if (resolvesTo(readable, el)) return readable;

    var steps = [];
    var node = el;
    while (node && node.parentElement) {
      var parent = node.parentElement;
      steps.unshift(':nth-child(' + ([].indexOf.call(parent.children, node) + 1) + ')');
      var anchor = selectorFor(parent);
      if (resolvesTo(anchor, parent)) return anchor + ' > ' + steps.join(' > ');
      node = parent;
    }
    // Nothing above it was unambiguous either, so anchor at the document itself.
    return node === document.documentElement ? 'html > ' + steps.join(' > ') : readable;
  }

  function pageOutline(query) {
    var limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500);
    var wantText = query.text !== false;
    var onlyViewport = query.viewport !== false;
    var root = document.body || document.documentElement;
    var cut = { hidden: 0, offscreen: 0, dropped: 0, text: 0, shadow: 0 };
    var found = [];

    var shadowHosts = [];
    var makeWalker = function (from) {
      return document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (el) {
        if (OUTLINE_PRUNE[el.tagName.toUpperCase()]) return NodeFilter.FILTER_REJECT;
        if (el.hasAttribute('data-custom-ai-view')) return NodeFilter.FILTER_REJECT;
        /*
         * Open shadow roots are walked too, in a second pass below.
         *
         * They used to be counted and skipped, on the ground that nothing here
         * could act on what was inside: every tool addressed elements with
         * document.querySelector, which stops at the boundary. That is no longer
         * true — selectors are resolved across every open root — so listing them
         * is now listing things that can actually be clicked, and a page built
         * out of custom elements no longer comes back looking empty.
         *
         * A closed root stays counted. It is genuinely unreachable from script,
         * and saying so is a different answer from finding nothing.
         */
        if (el.shadowRoot) shadowHosts.push(el);
        else if (el.tagName.indexOf('-') > 0 && !el.children.length && !ownText(el)) cut.shadow++;
        /*
         * aria-hidden, inert and display:none take their whole subtree with them,
         * and that is where most of the saving on a real page is: the closed menu,
         * the route that is not mounted, the four dialogs a design system parks in
         * the markup against the day they are needed. checkVisibility() with no
         * arguments answers for exactly the inherited part of "is this rendered", so
         * pruning on it cannot drop a child that is visible. Opacity and visibility
         * are asked per element instead, since a descendant may turn either back on.
         */
        if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert') || notRendered(el)) {
          if (kindOf(roleOf(el))) cut.hidden++;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
      });
    };

    var openControls = [];
    var node;
    // The document first, then each open shadow root as it is discovered — a
    // component may hold components, so the list grows while it is walked.
    var walkers = [makeWalker(root)];
    var walker = walkers.shift();
    for (;;) {
      node = walker.nextNode();
      if (!node) {
        // The root itself, not the host: the host's children in the light DOM
        // are a different tree from the one rendered inside it.
        while (shadowHosts.length) {
          var host = shadowHosts.shift();
          if (host.shadowRoot) walkers.push(makeWalker(host.shadowRoot));
        }
        if (!walkers.length) break;
        walker = walkers.shift();
        openControls.length = 0;      // a new root is a new containment chain
        continue;
      }
      if (found.length >= OUTLINE_SCAN_CAP) break;

      var role = roleOf(node);
      var kind = kindOf(role);
      var name = kind ? accessibleName(node, role) : '';
      // An image with no name has declared itself decoration; a frame with none is
      // still worth a row, because its contents are invisible from out here.
      if (role === 'image' && !name) continue;

      if (!kind && wantText) {
        // A <label>'s words belong to the control it names, and are reported there.
        var text = node.tagName === 'LABEL' ? '' : collapse(ownText(node), 120);
        if (text.length > 1) {
          role = 'text';
          kind = 'text';
          name = text;
        }
      }
      if (!kind) continue;

      var rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0) || hiddenByStyle(node) || fadedOut(node)) {
        cut.hidden++;
        continue;
      }
      if (onlyViewport ? !intersectsViewport(rect) : !intersectsDocument(rect)) {
        cut.offscreen++;
        continue;
      }

      /*
       * The words inside a button are the button's name, and were already reported
       * as such; repeating them as prose is the padding that makes these outlines
       * expensive. The stack rather than a single flag, because a control inside a
       * control still leaves the outer one open.
       */
      while (openControls.length && !openControls[openControls.length - 1].contains(node)) {
        openControls.pop();
      }
      if (kind === 'text' && openControls.length) continue;
      if (kind === 'control') openControls.push(node);

      found.push({
        kind: kind,
        role: role,
        name: name,
        value: kind === 'control' ? outlineValue(node, role) : '',
        state: kind === 'control' ? outlineState(node) : [],
        el: node,
        take: false,
      });
    }

    /*
     * Controls first, prose second.
     *
     * On an article the paragraphs outnumber the buttons twenty to one, so a cap
     * applied in document order spends the whole budget before it reaches the footer
     * navigation — the one thing an agent needs to get off the page. Both passes keep
     * document order among what they take, and the rows go out in that order, so the
     * outline still reads top to bottom.
     */
    var budget = limit;
    for (var pass = 0; pass < 2 && budget > 0; pass++) {
      for (var i = 0; i < found.length && budget > 0; i++) {
        if (found[i].take || (found[i].kind === 'text') !== (pass === 1)) continue;
        found[i].take = true;
        budget--;
      }
    }

    var entries = [];
    for (var j = 0; j < found.length; j++) {
      var item = found[j];
      if (!item.take) {
        if (item.kind === 'text') cut.text++;
        else cut.dropped++;
        continue;
      }
      var entry = { role: item.role, name: item.name, ref: refFor(item.el) };
      if (item.value) entry.value = item.value;
      if (item.state.length) entry.state = item.state;
      entries.push(entry);
    }

    var doc = document.documentElement;
    return {
      entries: entries,
      counts: cut,
      scope: onlyViewport ? 'viewport' : 'page',
      limit: limit,
      viewportBox: {
        w: window.innerWidth || 0,
        h: window.innerHeight || 0,
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        pageHeight: doc ? doc.scrollHeight : 0,
      },
      url: realUrl(location.href),
      title: document.title,
    };
  }

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

  /*
   * The reply must carry the request id it was asked with.
   *
   * The panel drives this by listening for the message type alone, so the id
   * was never missed there. An outside caller cannot: __dpAsk pairs a reply to
   * its request by `rid`, and a dp:tree without one matched nothing, waited
   * out the eight-second timeout, and came back as "The page did not answer in
   * time. Is it loaded through the proxy?" — which sent whoever read it to go
   * and check the proxy, which was fine. custom_ai_view_tree had never once
   * returned a tree.
   *
   * `rid` is left off entirely when the panel asks, so nothing there changes.
   */
  /*
   * Make a value safe to post.
   *
   * postMessage clones structurally, and structural cloning throws on a
   * function, a DOM node, a Window, a Proxy and anything circular. The throw
   * would happen inside toParent — that is, after the reply was already
   * committed to — so the caller would wait out its timeout and be told the
   * page had stopped answering, when in truth it had answered with a
   * `<div>`. Everything is therefore flattened to something clonable first,
   * with depth and breadth bounded so a store holding the whole application
   * cannot be dragged across the channel either.
   */
  function clonable(value, depth, seen) {
    var d = depth || 0;
    if (value === null || value === undefined) return value === undefined ? '(undefined)' : null;
    var t = typeof value;
    if (t === 'string') return value.length > 20000 ? value.slice(0, 20000) + '… (' + value.length + ' chars)' : value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'bigint') return String(value) + 'n';
    if (t === 'symbol') return String(value);
    if (t === 'function') {
      return '(function ' + (value.name || 'anonymous') + ') ' + String(value).slice(0, 200);
    }
    if (value instanceof Error) return '(' + value.name + ') ' + value.message;
    if (typeof Element !== 'undefined' && value instanceof Element) return '<' + describe(value) + '>';
    if (typeof Node !== 'undefined' && value instanceof Node) return '(node ' + value.nodeName + ')';
    if (value === window) return '(window)';
    if (typeof value.then === 'function') return '(pending promise)';
    if (d >= 4) return '(…)';

    var marks = seen || [];
    if (marks.indexOf(value) >= 0) return '(circular)';
    marks = marks.concat([value]);

    if (Array.isArray(value)) {
      var cap = Math.min(value.length, 100);
      var out = [];
      for (var i = 0; i < cap; i++) out.push(clonable(value[i], d + 1, marks));
      if (value.length > cap) out.push('… ' + (value.length - cap) + ' more');
      return out;
    }
    if (typeof Map !== 'undefined' && value instanceof Map) return '(Map of ' + value.size + ')';
    if (typeof Set !== 'undefined' && value instanceof Set) return '(Set of ' + value.size + ')';

    var obj = {};
    var keys;
    try { keys = Object.keys(value); } catch (e) { return '(unreadable object)'; }
    for (var k = 0; k < Math.min(keys.length, 60); k++) {
      try { obj[keys[k]] = clonable(value[keys[k]], d + 1, marks); } catch (e) { obj[keys[k]] = '(threw on read)'; }
    }
    if (keys.length > 60) obj['…'] = (keys.length - 60) + ' more keys';
    return obj;
  }

  function replyEval(rid, value) {
    var safeValue;
    try { safeValue = clonable(value, 0, []); } catch (e) { safeValue = '(could not be represented)'; }
    toParent({ type: 'dp:evaluated', rid: rid, value: safeValue, kind: typeof value });
  }

  /*
   * How long the document has been still.
   *
   * "Has it finished loading" is answered by readyState on a page that loads
   * once. On a single-page app readyState is 'complete' the moment the shell
   * arrives and stays that way for the rest of the session — so a wait for
   * "loading to finish" returned true immediately, every time, however much
   * was still in flight. What actually distinguishes a settled view from one
   * still assembling itself is that the DOM has stopped changing.
   *
   * The observer is installed on first use rather than at load: a page nobody
   * ever waits on should not pay for it.
   */
  var lastMutation = 0;
  var quietObserver = null;
  function quietSince() {
    if (!quietObserver && window.MutationObserver && document.documentElement) {
      lastMutation = Date.now();
      quietObserver = new MutationObserver(function () { lastMutation = Date.now(); });
      quietObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      // Nothing is known about the past, so the first answer must not claim
      // stillness it did not observe.
      return 0;
    }
    return lastMutation ? Date.now() - lastMutation : 0;
  }

  function sendTree(path, rid) {
    var reply = function (extra) {
      var msg = { type: 'dp:tree', path: path || [] };
      if (rid) msg.rid = rid;
      toParent(Object.assign(msg, extra));
    };
    var el = nodeAt(path);
    if (!el) {
      reply({ children: [], error: 'gone' });
      return;
    }
    var kids = elementChildren(el);
    var children = [];
    // A wall of ten thousand siblings helps nobody; the panel says how many were cut.
    var limit = Math.min(kids.length, 300);
    for (var i = 0; i < limit; i++) {
      children.push(nodeSummary(kids[i], (path || []).concat([i])));
    }
    reply({
      children: children,
      truncated: kids.length - limit,
      root: (path || []).length === 0 ? nodeSummary(el, []) : null,
    });
  }

  // ----------------------------------------------------------- page audit

  /*
   * Whether a person could actually use this page, at this size.
   *
   * Everything else here reports what an element IS — its box, its role, its text.
   * A box decides nothing on its own: 30 × 30 is a comfortable button under a
   * mouse and a coin toss under a thumb, and the only thing that can tell those
   * apart is something that knows it is standing in for a 6.3-inch phone with a
   * 62-point inset and a home indicator floating over the last 34 points of the
   * glass. The device was measured in millimetres so that this could be concluded
   * from it; measuring and then concluding nothing is where every other tool of
   * this kind stops.
   *
   * Each verdict carries the element and the number it was reached by, and none of
   * them is withheld. A 28-point button on a debug overlay is a fact about the
   * page, and whether it matters is the caller's business rather than this file's.
   */

  /*
   * Apple states its minimum in points, and on every device in the catalogue a
   * point is a CSS pixel — the catalogue is written in CSS px, and PROFILE.dpr is
   * what turns those into hardware pixels. Nothing here converts, deliberately: a
   * page laid out in px is measured in the unit it was laid out in.
   */
  var TAP_MIN = 44;   // the contact patch of a fingertip
  var TAP_GAP = 8;    // closer than this and one fingertip covers both
  var TEXT_MIN = 12;  // below this nothing is readable at arm's length

  var AUDIT_NODES = 12000;
  var AUDIT_TAPS = 1500;
  var AUDIT_WIDE = 400;

  // Elements that paint something of their own, so a rectangle over one of them is
  // content rather than a container that happens to reach the edge of the glass.
  var REPLACED = { IMG: 1, SVG: 1, VIDEO: 1, CANVAS: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1 };

  function boxOf(r) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function unionBox(a, b) {
    var left = Math.min(a.left, b.left);
    var top = Math.min(a.top, b.top);
    var right = Math.max(a.right, b.right);
    var bottom = Math.max(a.bottom, b.bottom);
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  /*
   * Where the element's own words actually sit.
   *
   * A header that runs edge to edge starts at y = 0 by design, and what must not
   * be under the notch is the text inside it. Measuring the box would report every
   * full-bleed container on the page as buried; a range over the element's own
   * text nodes gives the line boxes instead, which is the ink a person is trying
   * to read.
   */
  function inkRect(el) {
    var box = null;
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType !== 3 || !/\S/.test(node.nodeValue)) continue;
      var rects;
      try {
        var range = document.createRange();
        range.selectNode(node);
        rects = range.getClientRects();
      } catch (e) {
        continue;
      }
      for (var j = 0; j < rects.length; j++) {
        if (!rects[j].width || !rects[j].height) continue;
        box = box ? unionBox(box, rects[j]) : boxOf(rects[j]);
      }
    }
    return box;
  }

  /** Everything a finger can land on, including the things built out of a div. */
  function tapKind(el, style, parentStyle) {
    var role = roleOf(el);
    if (role && CONTROL_ROLES[role]) return role;
    if (el.tagName === 'LABEL' && el.hasAttribute('for')) return 'label';
    if (el.hasAttribute('onclick')) return 'button';
    /*
     * The div a designer made clickable, which is the commonest control in a
     * modern application and answers to none of the above: a handler added with
     * addEventListener leaves no mark in the markup, and the pointer cursor is the
     * only thing it does leave. cursor inherits, though, so every span inside such
     * a div claims to be a control too — only the outermost element of a pointer
     * subtree is the thing being tapped.
     */
    if (style.cursor === 'pointer' && (!parentStyle || parentStyle.cursor !== 'pointer')) {
      return 'cursor:pointer';
    }
    return '';
  }

  /** Held against the glass, rather than scrolling past it. */
  function isPinned(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      var pos;
      try {
        pos = getComputedStyle(node).position;
      } catch (e) {
        return false;
      }
      if (pos === 'fixed' || pos === 'sticky') return true;
      node = node.parentElement;
    }
    return false;
  }

  /*
   * Does this element's width actually reach the page?
   *
   * A carousel is meant to be wider than the screen — the strip is 2000 points
   * long and its container clips it — and calling that a broken layout would make
   * the audit useless on every site with a row of cards. What matters is whether
   * anything clips it before the viewport has to. html and body are the exception
   * worth naming separately: overflow-x:hidden there takes away the sideways
   * scrollbar but not the damage, and the content is still cut off.
   */
  function clipsHorizontally(el, vw) {
    var node = el.parentElement;
    while (node) {
      var style;
      try {
        style = getComputedStyle(node);
      } catch (e) {
        return 'none';
      }
      if (style.overflowX && style.overflowX !== 'visible') {
        if (node === document.body || node === document.documentElement) return 'root';
        if (node.getBoundingClientRect().right <= vw + 1) return 'clipped';
      }
      node = node.parentElement;
    }
    return 'none';
  }

  /** The shortest distance a fingertip has to travel from one box to the other. */
  function gapBetween(a, b) {
    var dx = Math.max(a.left - b.right, b.left - a.right, 0);
    var dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
    if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy);
    return Math.max(dx, dy);
  }

  /** Every finding names the element twice: as a person reads it, and as a tool takes it. */
  function auditFinding(el, extra) {
    var role = roleOf(el);
    return Object.assign({
      name: describe(el),
      ref: refFor(el),
      label: accessibleName(el, role),
    }, extra);
  }

  function auditPage(req) {
    var limit = Math.min(Math.max(parseInt(req.limit, 10) || 12, 1), 50);
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var screenH = Number(PROFILE.height) || vh;
    var notes = [];

    /*
     * How much of the safe area is still the page's problem.
     *
     * The device frame insets the iframe below the status bar unless it has been
     * set to draw edge to edge, so on the default setting nothing in the page CAN
     * be under the notch, and reporting that it is would be a lie with a number
     * attached to it. The bottom is the other way round: no phone carves out a
     * band for the home indicator — it floats over the page, and the page runs to
     * the edge of the glass — so those points are always live.
     *
     * The host knows which of those settings is in force and says so. The fallback
     * is for when nobody said, and reads the only evidence there is inside the
     * frame: a viewport shorter than the screen means the top has been taken out
     * already.
     */
    var reserved = Math.max(0, screenH - vh);
    var told = req.safeTop !== undefined && req.safeTop !== null;
    var safeTop = told
      ? Math.max(0, Number(req.safeTop) || 0)
      : reserved > 0 ? 0 : Math.max(0, Number(PROFILE.safeTop) || 0);
    var safeBottom = req.safeBottom !== undefined && req.safeBottom !== null
      ? Math.max(0, Number(req.safeBottom) || 0)
      : Math.max(0, Number(PROFILE.safeBottom) || 0);

    var scrollY = window.scrollY || 0;
    var scroller = document.scrollingElement || document.documentElement;
    var pageWidth = scroller ? scroller.scrollWidth : vw;
    var atTop = scrollY <= 0;
    var atBottom = scroller ? scrollY + vh >= scroller.scrollHeight - 2 : true;

    var taps = [];
    var small = [];
    var unsafe = [];
    var wide = [];
    var checked = 0;
    var capped = false;
    var i;

    /*
     * Our own cursor override has to come off first.
     *
     * The finger is drawn by hiding the real pointer with *{cursor:none}, and that
     * beats anything the page has to say — so with it installed every element in
     * the document computes cursor:none, and every clickable div disappears from
     * the audit. It goes back on in the finally, and nothing paints in between
     * because nothing in here yields.
     */
    var hidCursor = fingerStyle;
    if (hidCursor) hidCursor.disabled = true;

    try {
      var stack = [[document.documentElement, null]];
      while (stack.length) {
        if (checked >= AUDIT_NODES) {
          capped = true;
          break;
        }
        var frame = stack.pop();
        var el = frame[0];
        var parentStyle = frame[1];
        checked++;

        var style;
        try {
          style = getComputedStyle(el);
        } catch (e) {
          continue;
        }
        // A subtree that is display:none, or faded out by an ancestor, paints
        // nothing at all — and nothing that paints nothing can be tapped, read or
        // overflow anything.
        if (style.display === 'none' || parseFloat(style.opacity) === 0) continue;

        var kids = el.children;
        for (var k = kids.length - 1; k >= 0; k--) {
          // The finger, the ripple and the inspector's overlays are not part of
          // the page and must never be audited as though they were.
          if (kids[k].hasAttribute && kids[k].hasAttribute('data-custom-ai-view')) continue;
          stack.push([kids[k], style]);
        }

        if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        var rect = el.getBoundingClientRect();
        if (!(rect.width > 0 || rect.height > 0)) continue;

        var kind = tapKind(el, style, parentStyle);
        if (kind && !el.disabled && style.pointerEvents !== 'none' &&
            rect.width > 0 && rect.height > 0 && taps.length < AUDIT_TAPS) {
          taps.push({ el: el, kind: kind, rect: boxOf(rect) });
        }

        var text = ownText(el);
        var ink = /\S/.test(text) ? inkRect(el) : null;

        var fontSize = parseFloat(style.fontSize) || 0;
        if (ink && fontSize > 0 && fontSize < TEXT_MIN) {
          small.push({ el: el, size: fontSize, rect: ink, text: text });
        }

        /*
         * What counts as content sitting in the inset: the element's own words, or
         * a picture or a control. A full-screen backdrop is skipped, because a
         * hero image is meant to run under the notch and a wrapper that fills the
         * viewport is not something anybody is trying to read.
         */
        var band = ink;
        if (!band && REPLACED[el.tagName]) {
          var covering = rect.height >= vh * 0.8 || rect.width * rect.height >= vw * vh * 0.6;
          if (!covering) band = boxOf(rect);
        }
        if (band && band.right > 0 && band.left < vw && band.bottom > 0 && band.top < vh) {
          var overTop = safeTop > 0 ? safeTop - band.top : 0;
          var overBottom = safeBottom > 0 ? band.bottom - (vh - safeBottom) : 0;
          if (overTop >= 1 || overBottom >= 1) {
            /*
             * Content passing under the status bar is what scrolling looks like,
             * not a defect. It is a finding when the element is held against the
             * glass, or when the page has already run out in that direction —
             * which is when nothing else is going to move it out from under.
             */
            var pinned = isPinned(el);
            if (overTop >= 1 && (pinned || atTop)) {
              unsafe.push({ el: el, edge: 'top', overlap: overTop, rect: band, pinned: pinned, text: text });
            }
            if (overBottom >= 1 && (pinned || atBottom)) {
              unsafe.push({ el: el, edge: 'bottom', overlap: overBottom, rect: band, pinned: pinned, text: text });
            }
          }
        }

        if ((rect.right > vw + 1 || rect.left < -1) && wide.length < AUDIT_WIDE) {
          wide.push({ el: el, rect: boxOf(rect) });
        }
      }
    } finally {
      if (hidCursor) hidCursor.disabled = false;
    }

    /*
     * Which box a finger is actually aiming at.
     *
     * A checkbox is tapped by tapping its label, and a 12-point icon inside a
     * 48-point anchor is tapped by tapping the anchor. Where a wrapper holds
     * exactly one control the wrapper is the target, and measuring the control on
     * its own reports a button nobody has to hit; where it holds several it is a
     * container, and each control inside it is on its own.
     */
    var index = new Map();
    for (i = 0; i < taps.length; i++) index.set(taps[i].el, i);
    for (i = 0; i < taps.length; i++) {
      var up = taps[i].el.parentElement;
      while (up) {
        var owner = index.get(up);
        if (owner !== undefined) {
          taps[i].owner = owner;
          taps[owner].inside = (taps[owner].inside || 0) + 1;
          break;
        }
        up = up.parentElement;
      }
    }

    var targets = [];
    for (i = 0; i < taps.length; i++) {
      if (taps[i].inside) continue;
      var box = taps[i].rect;
      var named = taps[i];
      var owns = taps[i].owner;
      while (owns !== undefined && taps[owns].inside === 1) {
        box = unionBox(box, taps[owns].rect);
        named = taps[owns];
        owns = taps[owns].owner;
      }
      targets.push({ el: named.el, kind: named.kind, rect: box });
    }

    var tapTargets = [];
    var crowding = [];
    if (!TOUCH) {
      // 44 points is a fingertip. On something driven by a mouse the number is
      // not wrong, it is about somebody who is not there.
      notes.push('Tap-target and spacing checks were skipped: this device is driven by a mouse.');
    } else {
      for (i = 0; i < targets.length; i++) {
        if (targets[i].rect.width >= TAP_MIN && targets[i].rect.height >= TAP_MIN) continue;
        tapTargets.push(targets[i]);
      }
      tapTargets.sort(function (a, b) {
        return Math.min(a.rect.width, a.rect.height) - Math.min(b.rect.width, b.rect.height);
      });

      /*
       * Two targets one fingertip covers at once.
       *
       * A list of 48-point rows that share an edge is a list, and a list is fine:
       * there are 24 points either side of the boundary and the thumb has
       * somewhere to land. Two 24-point icons three points apart are a coin toss.
       * So closeness is only a finding against a target that is already under the
       * minimum — otherwise every table on the web comes back as a defect and the
       * report is thrown away whole.
       */
      for (i = 0; i < targets.length; i++) {
        for (var j = i + 1; j < targets.length; j++) {
          var a = targets[i].rect;
          var b = targets[j].rect;
          var gap = gapBetween(a, b);
          if (gap >= TAP_GAP) continue;
          if (Math.min(a.width, a.height) >= TAP_MIN && Math.min(b.width, b.height) >= TAP_MIN) continue;
          crowding.push({ a: targets[i], b: targets[j], gap: gap });
        }
      }
      crowding.sort(function (x, y) { return x.gap - y.gap; });
    }

    // The offenders that reach the page, rather than the ones a carousel is
    // holding on purpose.
    var overflow = [];
    for (i = 0; i < wide.length; i++) {
      var clip = clipsHorizontally(wide[i].el, vw);
      if (clip === 'clipped') continue;
      overflow.push({
        el: wide[i].el,
        rect: wide[i].rect,
        past: Math.max(wide[i].rect.right - vw, -wide[i].rect.left, 0),
        cutOff: clip === 'root',
      });
    }
    overflow.sort(function (x, y) { return y.past - x.past; });

    small.sort(function (x, y) { return x.size - y.size; });
    unsafe.sort(function (x, y) { return y.overlap - x.overlap; });

    var round = function (n) { return Math.round(n * 10) / 10; };

    /*
     * Everything below crosses postMessage, which clones structurally: numbers,
     * strings, booleans and plain objects only. Not one element reference goes
     * out — a DOM node in here throws inside the reply, after the caller has
     * already committed to waiting for it, and comes back as a page that stopped
     * answering.
     */
    return {
      url: realUrl(location.href),
      title: document.title,
      viewport: { width: vw, height: vh },
      screen: { width: Number(PROFILE.width) || vw, height: screenH, dpr: Number(PROFILE.dpr) || 1 },
      touch: TOUCH,
      safeTop: safeTop,
      safeBottom: safeBottom,
      safeAreaFrom: told ? 'host' : 'inferred',
      scrollY: Math.round(scrollY),
      atTop: atTop,
      atBottom: atBottom,
      pageWidth: Math.round(pageWidth),
      interactive: targets.length,
      checked: checked,
      capped: capped,
      // What the caller is not being shown, so a bounded list never reads as a
      // complete one.
      counts: {
        tapTargets: tapTargets.length,
        safeArea: unsafe.length,
        overflow: overflow.length,
        smallText: small.length,
        crowding: crowding.length,
      },
      tapTargets: tapTargets.slice(0, limit).map(function (t) {
        return auditFinding(t.el, {
          kind: t.kind,
          width: round(t.rect.width),
          height: round(t.rect.height),
          x: Math.round(t.rect.left),
          y: Math.round(t.rect.top),
          offscreen: !intersectsViewport(t.rect),
        });
      }),
      safeArea: unsafe.slice(0, limit).map(function (f) {
        return auditFinding(f.el, {
          edge: f.edge,
          overlap: round(f.overlap),
          x: Math.round(f.rect.left),
          y: Math.round(f.rect.top),
          width: round(f.rect.width),
          height: round(f.rect.height),
          pinned: f.pinned,
          text: collapse(f.text, 60),
        });
      }),
      overflow: overflow.slice(0, limit).map(function (f) {
        return auditFinding(f.el, {
          past: round(f.past),
          width: round(f.rect.width),
          right: Math.round(f.rect.right),
          x: Math.round(f.rect.left),
          y: Math.round(f.rect.top),
          cutOff: f.cutOff,
        });
      }),
      smallText: small.slice(0, limit).map(function (f) {
        return auditFinding(f.el, {
          fontSize: round(f.size),
          x: Math.round(f.rect.left),
          y: Math.round(f.rect.top),
          text: collapse(f.text, 60),
        });
      }),
      crowding: crowding.slice(0, limit).map(function (f) {
        return {
          gap: round(f.gap),
          name: describe(f.a.el),
          ref: refFor(f.a.el),
          size: round(f.a.rect.width) + '×' + round(f.a.rect.height),
          otherName: describe(f.b.el),
          otherRef: refFor(f.b.el),
          otherSize: round(f.b.rect.width) + '×' + round(f.b.rect.height),
          x: Math.round(Math.min(f.a.rect.left, f.b.rect.left)),
          y: Math.round(Math.min(f.a.rect.top, f.b.rect.top)),
        };
      }),
      notes: notes,
    };
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
          var el = data.selector ? pick(data.selector) : null;
          inspector.selected = el;
          paintSelection();
        });
        break;
      case 'dp:cmd:input':
        /*
         * Input driven from outside, by selector rather than by coordinates: the
         * page is scaled and offset inside the device frame, so window coordinates
         * mean nothing here — a selector is the only stable address.
         *
         * This one does NOT use safe(). safe() catches and warns into a console
         * nobody outside the frame is reading, and never replies — so a throw
         * here left the caller waiting out its eight-second timeout and told it
         * "The page did not answer in time. Is it loaded through the proxy?".
         * The proxy was fine; the element was a <select>. A wrong tool has to
         * come back as a wrong tool, in milliseconds, saying which element it
         * was and what it is.
         */
        (function () {
          try {
          var el = data.selector ? pick(data.selector) : null;
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

            /*
             * Is anything on top of it?
             *
             * The event was dispatched straight at the element, so a click
             * "succeeded" on a button behind an open modal, under a cookie
             * banner, or beneath a full-screen overlay — and the agent, told it
             * had clicked, went on to wait for something that was never going
             * to happen. A real finger cannot reach through a sheet of glass.
             *
             * Reported rather than refused: a decorative wrapper covering its
             * own child is normal, and only the caller knows whether the thing
             * on top matters.
             */
            var onTop = null;
            try {
              var hit = document.elementFromPoint(cx, cy);
              if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) onTop = describe(hit);
            } catch (e) { /* detached, or outside the viewport */ }

            var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
            var touchy = PROFILE && PROFILE.touch;
            // A phone fires touch events, and a page that listens for touchstart
            // rather than click — a carousel, a custom button — never heard from
            // us at all.
            if (touchy && window.Touch && window.TouchEvent) {
              try {
                var touch = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy,
                  radiusX: 11, radiusY: 11, force: 1 });
                ['touchstart', 'touchend'].forEach(function (t) {
                  el.dispatchEvent(new TouchEvent(t, {
                    bubbles: true, cancelable: true, composed: true, view: window,
                    touches: t === 'touchstart' ? [touch] : [],
                    targetTouches: t === 'touchstart' ? [touch] : [],
                    changedTouches: [touch],
                  }));
                });
              } catch (e) { /* the constructor is not everywhere; the mouse events still land */ }
            }
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
              var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
              el.dispatchEvent(new Ctor(type, type.indexOf('pointer') === 0
                ? Object.assign({ pointerId: 1, pointerType: touchy ? 'touch' : 'mouse', isPrimary: true }, opts)
                : opts));
            });
            if (typeof el.focus === 'function') el.focus();
            toParent({
              type: 'dp:input-done', rid: data.rid, kind: 'click', name: describe(el),
              covered: onTop,
              // 44pt is the contact patch of a fingertip. Below it the tap is a
              // matter of luck, and that is worth saying at the moment of the
              // click rather than in a later audit nobody runs.
              small: PROFILE && PROFILE.touch && (rect.width < 44 || rect.height < 44)
                ? Math.round(rect.width) + '×' + Math.round(rect.height) : null,
            });
            return;
          }

          /*
           * Hover.
           *
           * A menu that opens on hover, a tooltip, a row that reveals its
           * actions — none of them could be reached at all. Clicking is not a
           * substitute: on a page that opens a submenu on mouseenter, a click
           * lands on the parent and the submenu never appears.
           */
          if (data.kind === 'hover') {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            var hr = el.getBoundingClientRect();
            var hx = hr.left + hr.width / 2;
            var hy = hr.top + hr.height / 2;
            var hopts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: hx, clientY: hy };
            ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerenter', 'mouseenter']
              .forEach(function (type) {
                var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
                // enter and over differ in whether they bubble; a page that
                // listens for the wrong one otherwise sees nothing.
                var o = Object.assign({}, hopts, { bubbles: type.indexOf('enter') < 0 });
                el.dispatchEvent(new Ctor(type, type.indexOf('pointer') === 0
                  ? Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o) : o));
              });
            toParent({ type: 'dp:input-done', rid: data.rid, kind: 'hover', name: describe(el) });
            return;
          }

          /*
           * Drag, which on a phone is a swipe.
           *
           * A carousel, a slider, a sheet you pull up, a swipe-to-delete row:
           * all of them need a press, several moves and a release, and none of
           * them respond to a click. The moves matter — a single jump from
           * start to end is read as a flick by some libraries and ignored by
           * others, so the path is walked in steps.
           */
          if (data.kind === 'drag') {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            var dr = el.getBoundingClientRect();
            var sx = dr.left + dr.width / 2;
            var sy = dr.top + dr.height / 2;
            var ex = sx + (data.dx || 0);
            var ey = sy + (data.dy || 0);
            var steps = Math.max(4, Math.min(24, data.steps || 10));
            var isTouch = PROFILE && PROFILE.touch;
            var ptr = function (type, x, y, target) {
              var o = { bubbles: true, cancelable: true, composed: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 };
              (target || el).dispatchEvent(window.PointerEvent
                ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: isTouch ? 'touch' : 'mouse', isPrimary: true }, o))
                : new MouseEvent(type.replace('pointer', 'mouse'), o));
            };
            var touchEv = function (type, x, y, ending) {
              if (!isTouch || !window.Touch || !window.TouchEvent) return;
              try {
                var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, radiusX: 11, radiusY: 11, force: 1 });
                el.dispatchEvent(new TouchEvent(type, {
                  bubbles: true, cancelable: true, composed: true, view: window,
                  touches: ending ? [] : [t], targetTouches: ending ? [] : [t], changedTouches: [t],
                }));
              } catch (e) { /* not available here */ }
            };
            ptr('pointerdown', sx, sy);
            touchEv('touchstart', sx, sy, false);
            for (var s = 1; s <= steps; s++) {
              var px = sx + (ex - sx) * (s / steps);
              var py = sy + (ey - sy) * (s / steps);
              // Moves go to whatever is under the pointer, as they would in life
              // — a drag that leaves its element still has to be followed.
              var under = null;
              try { under = document.elementFromPoint(px, py); } catch (e) { under = null; }
              ptr('pointermove', px, py, under || el);
              touchEv('touchmove', px, py, false);
            }
            ptr('pointerup', ex, ey);
            touchEv('touchend', ex, ey, true);
            toParent({
              type: 'dp:input-done', rid: data.rid, kind: 'drag',
              name: 'dragged ' + describe(el) + ' by ' + Math.round(data.dx || 0) + ', ' + Math.round(data.dy || 0),
            });
            return;
          }

          /*
           * Put a file into a file input.
           *
           * The bytes arrive from the host, because a page cannot read the
           * disk. Without this every upload flow — an avatar, a document, an
           * import — is simply unreachable: the native picker cannot be driven
           * from script, and clicking the input only opens it.
           */
          if (data.kind === 'upload') {
            if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
              toParent({
                type: 'dp:input-done', rid: data.rid,
                error: describe(el) + ' is not a file input',
              });
              return;
            }
            var dt = new DataTransfer();
            (data.files || []).forEach(function (f) {
              var raw = atob(f.base64 || '');
              var bytes = new Uint8Array(raw.length);
              for (var bi = 0; bi < raw.length; bi++) bytes[bi] = raw.charCodeAt(bi);
              dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
            });
            el.files = dt.files;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            toParent({
              type: 'dp:input-done', rid: data.rid, kind: 'upload',
              name: (data.files || []).map(function (f) { return f.name; }).join(', ') + ' → ' + describe(el),
            });
            return;
          }
          if (data.kind === 'type') {
            if (typeof el.focus === 'function') el.focus();

            /*
             * A <select> is not a text field.
             *
             * The native value setter was taken from HTMLInputElement.prototype
             * and called on whatever matched. On a <select>, a contenteditable
             * div, or a custom element that throws "Illegal invocation" — and
             * the two fallbacks below it were unreachable, because the throw
             * came first. Every dropdown on every form was undrivable, and said
             * so by timing out.
             *
             * Choosing by visible label as well as by value is deliberate: an
             * agent reading the page sees "United Kingdom", not "GB".
             */
            if (el.tagName === 'SELECT') {
              var wanted = String(data.text);
              var picked = -1;
              for (var oi = 0; oi < el.options.length; oi++) {
                var opt = el.options[oi];
                if (opt.value === wanted || (opt.textContent || '').trim() === wanted) { picked = oi; break; }
              }
              if (picked < 0) {
                var had = [];
                for (var oj = 0; oj < Math.min(el.options.length, 12); oj++) {
                  had.push((el.options[oj].textContent || '').trim() + ' (' + el.options[oj].value + ')');
                }
                toParent({
                  type: 'dp:input-done', rid: data.rid,
                  error: 'No option "' + wanted + '" in ' + describe(el) + '. It offers: ' + had.join(', ')
                    + (el.options.length > 12 ? ', and ' + (el.options.length - 12) + ' more' : ''),
                });
                return;
              }
              el.selectedIndex = picked;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              toParent({
                type: 'dp:input-done', rid: data.rid, kind: 'select',
                name: 'chose "' + (el.options[picked].textContent || '').trim() + '" in ' + describe(el),
              });
              return;
            }

            // A rich-text editor has no value at all. execCommand is deprecated
            // and is still the only way to make one see a real input event —
            // setting textContent leaves React's editor state untouched.
            if (el.isContentEditable) {
              var range = document.createRange();
              range.selectNodeContents(el);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              var inserted = false;
              try { inserted = document.execCommand('insertText', false, data.text); } catch (e) { inserted = false; }
              if (!inserted) {
                el.textContent = data.text;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: data.text, inputType: 'insertText' }));
              }
              if (data.key) pressKey(el, data.key);
              toParent({ type: 'dp:input-done', rid: data.rid, kind: 'type', name: describe(el) });
              return;
            }

            var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
              : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
            // React and friends listen to the native setter, not to el.value = x.
            // Only reach for it when the element really is one of those two.
            var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
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
          } catch (err) {
            toParent({
              type: 'dp:input-done', rid: data.rid,
              error: String(err && err.message ? err.message : err)
                + (data.selector ? ' — on ' + data.selector : ''),
            });
          }
        })();
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
            // How long the document has been still. readyState went 'complete'
            // when the shell loaded and never changes again, so on a single-page
            // app it is true from the first tick and says nothing about whether
            // the view being waited for has arrived. Quiet does.
            msSinceMutation: quietSince(),
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
      /*
       * Run an expression in the page.
       *
       * Everything else here is a projection of the presentation layer: what an
       * element looks like, where its box is, what it says. None of it reaches
       * the application's own state — whether a store holds a user, what a media
       * query resolved to, whether a fetch came back. Without a way in, every
       * question about state becomes "take another screenshot and guess", and
       * any gap in the other tools is a dead end rather than a detour.
       *
       * Deliberately not inside safe(): safe() warns into a console nobody
       * outside the frame reads and never replies, so a syntax error would be
       * indistinguishable from a page that had stopped answering.
       */
      case 'dp:cmd:eval':
        (function () {
          try {
            var subject = data.selector ? pick(data.selector) : null;
            if (data.selector && !subject) {
              toParent({
                type: 'dp:evaluated', rid: data.rid,
                error: 'No element matched ' + data.selector,
              });
              return;
            }
            // An expression with `await` in it needs an async function to live
            // in — new Function makes an ordinary one, where await is a syntax
            // error, and the message ("Unexpected identifier") points at the
            // wrong thing entirely.
            var Ctor = /\bawait\b/.test(data.expression)
              ? Object.getPrototypeOf(async function () {}).constructor
              : Function;
            var fn = new Ctor('el', 'document', 'window',
              /^\s*(return|var|let|const|if|for|while|throw|\{)\b/.test(data.expression)
                ? data.expression
                : 'return (' + data.expression + ');');
            var value = fn(subject, document, window);
            if (value && typeof value.then === 'function') {
              value.then(
                function (v) { replyEval(data.rid, v); },
                function (e) {
                  toParent({ type: 'dp:evaluated', rid: data.rid, error: String(e && e.message ? e.message : e) });
                }
              );
              return;
            }
            replyEval(data.rid, value);
          } catch (err) {
            toParent({
              type: 'dp:evaluated', rid: data.rid,
              error: String(err && err.message ? err.message : err),
            });
          }
        })();
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
      /*
       * The outline of the page.
       *
       * Not inside safe(): safe() catches, warns into a console nobody outside the
       * frame is reading, and never replies — so a throw in the walk would come back
       * as "the page did not answer in time", sending whoever read it to look at the
       * proxy, which was fine. Everything in the payload is a string, a number or an
       * array of them, so it survives the structured clone without help; it must NOT
       * be passed through clonable(), which caps an array at a hundred items and
       * would quietly cut the outline in half.
       */
      case 'dp:cmd:snapshot':
        (function () {
          try {
            toParent(Object.assign({ type: 'dp:snapshot', rid: data.rid }, pageOutline(data)));
          } catch (err) {
            toParent({
              type: 'dp:snapshot', rid: data.rid,
              error: String(err && err.message ? err.message : err),
            });
          }
        })();
        break;
      case 'dp:cmd:edit':
        safe('edit', function () {
          var result = editElement(data);
          toParent(Object.assign({ type: 'dp:edited', rid: data.rid }, result));
        });
        break;
      /*
       * The audit, for the same reasons the outline is not inside safe(): a throw
       * in a walk over somebody else's document would be swallowed into a console
       * nobody outside the frame reads, and the caller would be told the page had
       * stopped answering. A walk that fell over has to say so, and say where.
       */
      case 'dp:cmd:audit':
        (function () {
          try {
            toParent(Object.assign({ type: 'dp:audit', rid: data.rid }, auditPage(data)));
          } catch (err) {
            toParent({
              type: 'dp:audit', rid: data.rid,
              error: String(err && err.message ? err.message : err),
            });
          }
        })();
        break;
      case 'dp:cmd:tree':
        safe('tree', function () {
          sendTree(data.path || [], data.rid);
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
      /*
       * Not wrapped in safe(). safe() catches, writes a warning into a console
       * nobody is reading, and never replies — so the caller waits out its
       * timeout and is told the page did not answer, which reads as a broken
       * proxy rather than as one bad selector. An invalid selector, a detached
       * node, a getComputedStyle on an element mid-teardown: all of them used
       * to look like the same eight-second silence.
       */
      case 'dp:cmd:describe':
        try {
          var described = data.selector ? pick(data.selector) : inspector.selected;
          // The request id goes back on every reply. Without it the bridge
          // cannot pair the answer with the question and waits out its timeout
          // instead — which is how tree spent months reporting that the page
          // had not answered while the page was answering every time.
          if (!described) {
            toParent({
              type: 'dp:described', rid: data.rid,
              error: 'No element matched ' + (data.selector || '(no selection)'),
            });
          } else {
            var describedReport = elementReport(described);
            describedReport.type = 'dp:described';
            describedReport.rid = data.rid;
            toParent(describedReport);
          }
        } catch (err) {
          toParent({
            type: 'dp:described', rid: data.rid,
            error: 'Could not describe it: ' + (err && err.message ? err.message : err),
          });
        }
        break;
      case 'dp:cmd:locate':
        safe('locate', function () {
          var el = data.selector ? pick(data.selector) : null;
          if (!el) return toParent({ type: 'dp:located', rect: null });
          var r = el.getBoundingClientRect();
          toParent({
            type: 'dp:located',
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          });
        });
        break;
      /*
       * Read and write the site's own storage.
       *
       * Not through eval: the point of namespacing was that a page cannot see
       * another site's keys, and an agent reaching in with a raw expression
       * would be reaching into the shared bucket underneath and undoing it.
       */
      case 'dp:cmd:storage':
        (function () {
          try {
            var which = data.store === 'session' ? 'sessionStorage' : 'localStorage';
            var store = window[which];
            if (!store) {
              toParent({ type: 'dp:storage', rid: data.rid, error: which + ' is not available here' });
              return;
            }
            if (data.op === 'set') {
              store.setItem(String(data.key), String(data.value));
            } else if (data.op === 'remove') {
              store.removeItem(String(data.key));
            } else if (data.op === 'clear') {
              store.clear();
            }
            var keys = store.__ownKeys ? store.__ownKeys() : (function () {
              var out = [];
              for (var i = 0; i < store.length; i++) out.push(store.key(i));
              return out;
            })();
            var items = {};
            var bytes = 0;
            keys.slice(0, 200).forEach(function (k) {
              var v = store.getItem(k);
              bytes += (k.length + (v ? v.length : 0)) * 2;
              // A token or a cached payload can be enormous; the shape is what
              // is wanted here, not the whole of it.
              items[k] = v === null ? null
                : (v.length > 400 ? v.slice(0, 400) + '… (' + v.length + ' chars)' : v);
            });
            toParent({
              type: 'dp:storage', rid: data.rid,
              store: which, url: realUrl(location.href),
              count: keys.length, truncated: Math.max(0, keys.length - 200),
              approxBytes: bytes,
              namespaced: !!STORE_PREFIX,
              items: items,
            });
          } catch (err) {
            toParent({
              type: 'dp:storage', rid: data.rid,
              error: String(err && err.message ? err.message : err),
            });
          }
        })();
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
