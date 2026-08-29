/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Device catalogue.
 *
 * Every number is in CSS pixels (logical points), portrait orientation.
 *   w / h        the viewport a full-screen web app gets — window.innerWidth/innerHeight
 *   dpr          devicePixelRatio, so `w * dpr` is the real panel resolution
 *   safeTop      env(safe-area-inset-top)      — status bar / notch area
 *   safeBottom   env(safe-area-inset-bottom)   — home indicator / gesture bar
 *   safeSide     env(safe-area-inset-left|right) in landscape
 *   radius       screen corner radius
 *   bezel        black border drawn around the screen; number or {t,r,b,l}
 *   cutout       none | notch | island | hole | hole-left | teardrop | mac-notch
 *   cw/ch/ct     cutout width / height / distance from the top of the screen
 *   buttons      side hardware buttons, positions as a fraction of screen height
 *   chrome       browser UI heights when "browser chrome" mode is on
 *
 * Loaded both by the extension host (CommonJS) and by the webview (global).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceCatalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  /** Side buttons, expressed as fractions of the screen height so they scale. */
  const BTN = {
    iphoneGesture: (opts = {}) => {
      const list = [
        { side: 'left', type: opts.action ? 'action' : 'mute', top: 0.143, len: opts.action ? 0.032 : 0.026 },
        { side: 'left', type: 'vol', top: 0.209, len: 0.07 },
        { side: 'left', type: 'vol', top: 0.296, len: 0.07 },
        { side: 'right', type: 'power', top: 0.223, len: 0.117 },
      ];
      if (opts.camera) list.push({ side: 'right', type: 'camera', top: 0.4, len: 0.03 });
      return list;
    },
    iphoneHome: () => [
      { side: 'left', type: 'mute', top: 0.14, len: 0.03 },
      { side: 'left', type: 'vol', top: 0.2, len: 0.06 },
      { side: 'left', type: 'vol', top: 0.28, len: 0.06 },
      { side: 'right', type: 'power', top: 0.2, len: 0.1 },
    ],
    galaxy: () => [
      { side: 'right', type: 'vol', top: 0.17, len: 0.075 },
      { side: 'right', type: 'vol', top: 0.255, len: 0.075 },
      { side: 'right', type: 'power', top: 0.35, len: 0.055 },
    ],
    pixel: () => [
      { side: 'right', type: 'power', top: 0.17, len: 0.06 },
      { side: 'right', type: 'vol', top: 0.25, len: 0.11 },
    ],
    ipadGesture: () => [
      { side: 'top', type: 'power', top: 0.78, len: 0.06 },
      { side: 'right', type: 'vol', top: 0.05, len: 0.05 },
      { side: 'right', type: 'vol', top: 0.12, len: 0.05 },
    ],
    ipadHome: () => [
      { side: 'top', type: 'power', top: 0.8, len: 0.06 },
      { side: 'right', type: 'vol', top: 0.06, len: 0.05 },
      { side: 'right', type: 'vol', top: 0.13, len: 0.05 },
    ],
    none: () => [],
  };

  /** iOS Safari chrome. Modern iOS puts the address bar at the bottom. */
  const CHROME_IOS = { top: 0, bottom: 52, kind: 'ios-safari' };
  const CHROME_IOS_HOME = { top: 44, bottom: 44, kind: 'ios-safari-legacy' };
  const CHROME_IPADOS = { top: 84, bottom: 0, kind: 'ipados-safari' };
  const CHROME_ANDROID = { top: 56, bottom: 0, kind: 'android-chrome' };
  const CHROME_MAC = { top: 80, bottom: 0, kind: 'macos-safari', menuBar: 24 };

  const IPHONE = {
    kind: 'phone', os: 'ios', brand: 'Apple', dpr: 3, bezel: 9,
    safeSide: 48, chrome: CHROME_IOS,
    finishes: ['graphite', 'black', 'silver', 'gold', 'desert', 'blue'],
  };
  /*
   * Android safe areas are the system status-bar and gesture-bar heights, which is
   * what a standalone web app with viewport-fit=cover actually gets. They are much
   * larger than the classic 24dp status bar on phones with a big camera cutout —
   * Pixel 9 reserves 66dp — and the cutout geometry below comes from each device's
   * config_mainBuiltInDisplayCutout path in AOSP rather than from eyeballing.
   */
  const GALAXY = {
    kind: 'phone', os: 'android', brand: 'Samsung', dpr: 3, bezel: 7,
    cutout: 'hole', cw: 18, ch: 18, ct: 11,
    safeTop: 34, safeBottom: 24, safeSide: 0, chrome: CHROME_ANDROID,
    finishes: ['black', 'graphite', 'silver', 'blue'],
  };
  const PIXEL = {
    kind: 'phone', os: 'android', brand: 'Google', dpr: 2.625, bezel: 8,
    cutout: 'hole', cw: 26, ch: 26, ct: 13,
    safeTop: 50, safeBottom: 24, safeSide: 0, chrome: CHROME_ANDROID,
    finishes: ['black', 'silver', 'blue', 'gold'],
  };
  const IPAD = {
    kind: 'tablet', os: 'ipados', brand: 'Apple', dpr: 2, bezel: 18,
    cutout: 'none', safeSide: 0, chrome: CHROME_IPADOS,
    finishes: ['silver', 'graphite', 'blue', 'gold'],
  };
  const MAC = {
    kind: 'laptop', os: 'macos', brand: 'Apple', dpr: 2, bezel: 10,
    cutout: 'none', safeTop: 0, safeBottom: 0, safeSide: 0, radius: 12,
    chrome: CHROME_MAC, finishes: ['silver', 'graphite', 'black'],
  };

  /**
   * The TrueDepth module is one physical size (~34.8 × 5.3 mm), so the notch in
   * *points* differs per panel density — it is not a fixed fraction of the screen
   * width. Values below are per-device rather than computed for that reason.
   * Gen 2 (iPhone 13 onwards) is the physically narrower, slightly taller module.
   */
  const notch = (cw, ch) => ({ cutout: 'notch', cw, ch, ct: 0 });

  /** Dynamic Island: a 125 × 36.67pt pill, 11pt below the top edge. */
  const island = (cw) => ({ cutout: 'island', cw: cw || 125, ch: 36.67, ct: 11 });

  const d = (base, o) => Object.assign({}, base, o);

  // ------------------------------------------------------------- iPhone

  const iphones = [
    d(IPHONE, {
      id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', year: 2025,
      w: 440, h: 956, radius: 62, bezel: 6, safeTop: 62, safeBottom: 34,
      ...island(126), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-17-pro', name: 'iPhone 17 Pro', year: 2025,
      w: 402, h: 874, radius: 62, bezel: 6, safeTop: 62, safeBottom: 34,
      ...island(126), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-17', name: 'iPhone 17', year: 2025,
      w: 402, h: 874, radius: 62, bezel: 7, safeTop: 62, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      // The Air is the outlier of the line: a 68pt top inset, not 62.
      id: 'iphone-air', name: 'iPhone Air', year: 2025,
      w: 420, h: 912, radius: 62, bezel: 6, safeTop: 68, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', year: 2024,
      w: 440, h: 956, radius: 62, bezel: 6, safeTop: 62, safeBottom: 34,
      ...island(126), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-16-pro', name: 'iPhone 16 Pro', year: 2024,
      w: 402, h: 874, radius: 62, bezel: 6, safeTop: 62, safeBottom: 34,
      ...island(126), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-16-plus', name: 'iPhone 16 Plus', year: 2024,
      w: 430, h: 932, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-16', name: 'iPhone 16', year: 2024,
      w: 393, h: 852, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true, camera: true }),
    }),
    d(IPHONE, {
      id: 'iphone-16e', name: 'iPhone 16e', year: 2025,
      w: 390, h: 844, radius: 47.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(162, 32), buttons: BTN.iphoneGesture({ action: true }),
    }),
    d(IPHONE, {
      id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', year: 2023,
      w: 430, h: 932, radius: 55, bezel: 7, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true }),
    }),
    d(IPHONE, {
      id: 'iphone-15-pro', name: 'iPhone 15 Pro', year: 2023,
      w: 393, h: 852, radius: 55, bezel: 7, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture({ action: true }),
    }),
    d(IPHONE, {
      id: 'iphone-15-plus', name: 'iPhone 15 Plus', year: 2023,
      w: 430, h: 932, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-15', name: 'iPhone 15', year: 2023,
      w: 393, h: 852, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-14-pro-max', name: 'iPhone 14 Pro Max', year: 2022,
      w: 430, h: 932, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-14-pro', name: 'iPhone 14 Pro', year: 2022,
      w: 393, h: 852, radius: 55, bezel: 8, safeTop: 59, safeBottom: 34,
      ...island(), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-14-plus', name: 'iPhone 14 Plus', year: 2022,
      w: 428, h: 926, radius: 53.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(161, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-14', name: 'iPhone 14', year: 2022,
      w: 390, h: 844, radius: 47.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(162, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-13-pro-max', name: 'iPhone 13 Pro Max', year: 2021,
      w: 428, h: 926, radius: 53.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(161, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-13', name: 'iPhone 13 / 13 Pro', year: 2021,
      w: 390, h: 844, radius: 47.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(162, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-13-mini', name: 'iPhone 13 mini', year: 2021,
      w: 375, h: 812, radius: 44, bezel: 9, safeTop: 50, safeBottom: 34,
      ...notch(174, 35), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-12-pro-max', name: 'iPhone 12 Pro Max', year: 2020,
      w: 428, h: 926, radius: 53.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(209, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-12', name: 'iPhone 12 / 12 Pro', year: 2020,
      w: 390, h: 844, radius: 47.33, bezel: 9, safeTop: 47, safeBottom: 34,
      ...notch(210, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-12-mini', name: 'iPhone 12 mini', year: 2020,
      w: 375, h: 812, radius: 44, bezel: 9, safeTop: 50, safeBottom: 34,
      ...notch(227, 34.5), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-11-pro-max', name: 'iPhone 11 Pro Max', year: 2019,
      w: 414, h: 896, radius: 39, bezel: 11, safeTop: 44, safeBottom: 34,
      ...notch(209, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-11', name: 'iPhone 11 / XR', year: 2019, dpr: 2,
      w: 414, h: 896, radius: 41.5, bezel: 12, safeTop: 48, safeBottom: 34,
      ...notch(224, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-x', name: 'iPhone X / XS / 11 Pro', year: 2017,
      w: 375, h: 812, radius: 39, bezel: 11, safeTop: 44, safeBottom: 34,
      ...notch(209, 32), buttons: BTN.iphoneGesture(),
    }),
    d(IPHONE, {
      id: 'iphone-se-3', name: 'iPhone SE (2nd / 3rd gen)', year: 2022, dpr: 2,
      w: 375, h: 667, radius: 0, safeTop: 20, safeBottom: 0,
      cutout: 'none', homeButton: true, chrome: CHROME_IOS_HOME,
      bezel: { t: 96, r: 13, b: 104, l: 13 },
      buttons: BTN.iphoneHome(),
    }),
    d(IPHONE, {
      id: 'iphone-8-plus', name: 'iPhone 8 Plus', year: 2017, dpr: 3,
      w: 414, h: 736, radius: 0, safeTop: 20, safeBottom: 0,
      cutout: 'none', homeButton: true, chrome: CHROME_IOS_HOME,
      bezel: { t: 100, r: 14, b: 108, l: 14 },
      buttons: BTN.iphoneHome(),
    }),
  ];

  // ------------------------------------------------------------- Android

  const androids = [
    d(GALAXY, {
      id: 'galaxy-s25-ultra', name: 'Galaxy S25 Ultra', year: 2025,
      w: 384, h: 832, dpr: 2.8125, radius: 36, bezel: 6,
      safeTop: 36, cw: 19, ch: 19, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s25', name: 'Galaxy S25', year: 2025,
      w: 360, h: 780, radius: 38, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s24-ultra', name: 'Galaxy S24 Ultra', year: 2024,
      w: 384, h: 832, dpr: 2.8125, radius: 26, bezel: 6,
      safeTop: 36, cw: 19, ch: 19, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s24-plus', name: 'Galaxy S24+', year: 2024,
      w: 384, h: 832, dpr: 2.8125, radius: 40,
      safeTop: 36, cw: 19, ch: 19, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s24', name: 'Galaxy S24', year: 2024,
      w: 360, h: 780, radius: 38, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s23', name: 'Galaxy S23', year: 2023,
      w: 360, h: 780, radius: 36, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s22', name: 'Galaxy S22', year: 2022,
      w: 360, h: 780, radius: 36, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-s21', name: 'Galaxy S21', year: 2021,
      w: 360, h: 800, radius: 36, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-a55', name: 'Galaxy A55', year: 2024,
      w: 412, h: 892, dpr: 2.625, radius: 34, bezel: 9,
      safeTop: 34, cw: 21, ch: 21, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-z-fold6-inner', name: 'Galaxy Z Fold 6 — unfolded', year: 2024,
      w: 707, h: 823, dpr: 2.625, radius: 18, bezel: 8,
      cutout: 'none', safeTop: 28, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-z-fold5-cover', name: 'Galaxy Z Fold 5 — cover screen', year: 2023,
      w: 344, h: 882, dpr: 2.625, radius: 30, bezel: 7,
      safeTop: 32, cw: 21, ch: 21, ct: 11, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'galaxy-z-flip6', name: 'Galaxy Z Flip 6', year: 2024,
      w: 360, h: 880, radius: 40, bezel: 7, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      // Pre-gesture Android: a 48dp three-button navigation bar, no camera cutout.
      id: 'galaxy-s8', name: 'Galaxy S8', year: 2017,
      w: 360, h: 740, dpr: 3, radius: 32, bezel: 10,
      cutout: 'none', safeTop: 24, safeBottom: 48, buttons: BTN.galaxy(),
    }),
    d(PIXEL, {
      id: 'pixel-9-pro-xl', name: 'Pixel 9 Pro XL', year: 2024,
      w: 448, h: 997, dpr: 3, radius: 48, bezel: 7,
      safeTop: 66, cw: 32, ch: 32, ct: 17, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-9-pro', name: 'Pixel 9 Pro', year: 2024,
      w: 427, h: 952, dpr: 3, radius: 48, bezel: 7,
      safeTop: 68, cw: 33, ch: 33, ct: 18, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-9', name: 'Pixel 9', year: 2024,
      w: 412, h: 924, radius: 46, bezel: 7,
      safeTop: 66, cw: 32, ch: 32, ct: 17, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-8-pro', name: 'Pixel 8 Pro', year: 2023,
      w: 448, h: 997, dpr: 3, radius: 44, bezel: 8,
      cw: 29, ch: 29, ct: 12, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-8', name: 'Pixel 8', year: 2023,
      w: 412, h: 915, radius: 44, bezel: 8,
      cw: 28, ch: 28, ct: 12, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-7-pro', name: 'Pixel 7 Pro', year: 2022,
      w: 412, h: 892, dpr: 3.5, radius: 42, bezel: 7,
      safeTop: 41, cw: 25, ch: 25, ct: 8, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-7', name: 'Pixel 7', year: 2022,
      w: 412, h: 915, radius: 38, bezel: 9,
      safeTop: 52, cw: 26, ch: 26, ct: 13, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-6-pro', name: 'Pixel 6 Pro', year: 2021,
      w: 412, h: 892, dpr: 3.5, radius: 42, bezel: 7,
      safeTop: 41, cw: 24, ch: 24, ct: 9, buttons: BTN.pixel(),
    }),
    d(PIXEL, {
      id: 'pixel-5', name: 'Pixel 5', year: 2020, dpr: 2.75,
      w: 393, h: 851, radius: 30, bezel: 9,
      safeTop: 30, cutout: 'hole-left', cw: 18, ch: 18, ct: 12, buttons: BTN.pixel(),
    }),
    d(GALAXY, {
      id: 'oneplus-12', name: 'OnePlus 12', brand: 'OnePlus', year: 2024,
      w: 412, h: 905, dpr: 3.5, radius: 46, bezel: 6,
      safeTop: 36, cw: 21, ch: 21, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'xiaomi-14', name: 'Xiaomi 14', brand: 'Xiaomi', year: 2024,
      w: 393, h: 873, dpr: 3.5, radius: 40, bezel: 6,
      safeTop: 36, cw: 20, ch: 20, ct: 12, buttons: BTN.galaxy(),
    }),
    d(GALAXY, {
      id: 'nothing-phone-2', name: 'Nothing Phone (2)', brand: 'Nothing', year: 2023,
      w: 412, h: 919, dpr: 2.625, radius: 42, bezel: 8,
      safeTop: 44, cw: 20, ch: 20, ct: 12, buttons: BTN.galaxy(),
    }),
  ];

  // ------------------------------------------------------------- iPad

  const ipads = [
    d(IPAD, {
      id: 'ipad-pro-13-m4', name: 'iPad Pro 13" (M4)', year: 2024,
      w: 1032, h: 1376, radius: 18, bezel: 16, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-pro-11-m4', name: 'iPad Pro 11" (M4)', year: 2024,
      w: 834, h: 1210, radius: 18, bezel: 15, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-pro-11-gen4', name: 'iPad Pro 11" (2018 – 2022)', year: 2022,
      w: 834, h: 1194, radius: 18, bezel: 18, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-pro-12-9', name: 'iPad Pro 12.9"', year: 2022,
      w: 1024, h: 1366, radius: 18, bezel: 20, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-air-13', name: 'iPad Air 13"', year: 2024,
      w: 1024, h: 1366, radius: 18, bezel: 20, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-air-11', name: 'iPad Air 11"', year: 2024,
      w: 820, h: 1180, radius: 18, bezel: 20, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-11', name: 'iPad (10th / 11th gen)', year: 2024,
      w: 820, h: 1180, radius: 18, bezel: 22, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-mini-7', name: 'iPad mini (A17 Pro)', year: 2024,
      w: 744, h: 1133, radius: 21, bezel: 16, safeTop: 24, safeBottom: 20,
      buttons: BTN.ipadGesture(),
    }),
    d(IPAD, {
      id: 'ipad-9', name: 'iPad (9th gen)', year: 2021,
      w: 810, h: 1080, radius: 0, safeTop: 20, safeBottom: 0,
      homeButton: true, bezel: { t: 76, r: 30, b: 76, l: 30 },
      buttons: BTN.ipadHome(),
    }),
  ];

  // ------------------------------------------------------------- Mac

  const macs = [
    d(MAC, {
      /*
       * A MacBook's chin is three times its forehead — the wordmark is etched down
       * there and the antenna runs behind it. What matters below is the RATIO: the
       * physical merge keeps t/(t+b) and re-derives the rest from the millimetres,
       * so a uniform bezel here quietly produced a symmetric lid no Mac has.
       */
      id: 'macbook-pro-16', name: 'MacBook Pro 16"', year: 2024,
      w: 1728, h: 1117, bezel: { t: 18, r: 18, b: 58, l: 18 },
      radius: 14, cutout: 'mac-notch', cw: 180, ch: 32, ct: 0,
      buttons: BTN.none(),
    }),
    d(MAC, {
      id: 'macbook-pro-14', name: 'MacBook Pro 14"', year: 2024,
      w: 1512, h: 982, bezel: { t: 17, r: 17, b: 52, l: 17 },
      radius: 14, cutout: 'mac-notch', cw: 165, ch: 30, ct: 0,
      buttons: BTN.none(),
    }),
    d(MAC, {
      // 1710 × 1107, not 1112 — the 15" Air's panel aspect is 1.5451, not the 13"'s.
      id: 'macbook-air-15', name: 'MacBook Air 15"', year: 2024,
      w: 1710, h: 1107, bezel: { t: 22, r: 22, b: 58, l: 22 },
      cutout: 'mac-notch', cw: 170, ch: 30, ct: 0,
      buttons: BTN.none(),
    }),
    d(MAC, {
      id: 'macbook-air-13', name: 'MacBook Air 13"', year: 2024,
      w: 1470, h: 956, bezel: { t: 20, r: 20, b: 52, l: 20 },
      cutout: 'mac-notch', cw: 160, ch: 30, ct: 0,
      buttons: BTN.none(),
    }),
    d(MAC, {
      // The last of the thick-bezel Pros: 9 mm of black glass at the sides and a
      // 19 mm chin, which is why it reads as an older machine at a glance.
      id: 'macbook-pro-13', name: 'MacBook Pro 13" (Intel / M1)', year: 2020,
      w: 1440, h: 900, bezel: { t: 44, r: 44, b: 92, l: 44 },
      radius: 4, cutout: 'none', buttons: BTN.none(),
    }),
    d(MAC, {
      // The default "looks like" mode is the exact 1:2 of the 4480 × 2520 panel.
      id: 'imac-24', name: 'iMac 24"', year: 2024, kind: 'desktop',
      w: 2240, h: 1260, bezel: 16, radius: 0, cutout: 'none', buttons: BTN.none(),
      finishes: ['silver', 'blue', 'gold'],
    }),
    d(MAC, {
      id: 'studio-display', name: 'Studio Display 27"', year: 2022, kind: 'desktop',
      w: 2560, h: 1440, bezel: 18, radius: 0, cutout: 'none', buttons: BTN.none(),
    }),
    d(MAC, {
      id: 'pro-display-xdr', name: 'Pro Display XDR 32"', year: 2019, kind: 'desktop',
      w: 3008, h: 1692, bezel: 20, radius: 0, cutout: 'none', buttons: BTN.none(),
    }),
    d(MAC, {
      id: 'desktop-1080', name: 'Desktop 1920 × 1080', year: 2020, kind: 'desktop',
      dpr: 1, w: 1920, h: 1080, bezel: 12, cutout: 'none', buttons: BTN.none(),
      finishes: ['black', 'graphite', 'silver'],
    }),
    d(MAC, {
      id: 'desktop-1440', name: 'Desktop 1440 × 900', year: 2018, kind: 'desktop',
      dpr: 1, w: 1440, h: 900, bezel: 12, cutout: 'none', buttons: BTN.none(),
      finishes: ['black', 'graphite', 'silver'],
    }),
  ];

  const CUSTOM = d(IPHONE, {
    id: 'custom', name: 'Custom size', brand: 'Custom', year: 9999,
    kind: 'phone', os: 'generic', dpr: 2,
    w: 400, h: 800, radius: 24, bezel: 8,
    cutout: 'none', safeTop: 0, safeBottom: 0, safeSide: 0,
    buttons: [], chrome: { top: 0, bottom: 0, kind: 'none' },
    finishes: ['graphite', 'black', 'silver'],
  });

  const DEVICES = [].concat(iphones, androids, ipads, macs, [CUSTOM]);

  // Fill in the fields every consumer expects, so nothing has to guard.
  for (const dev of DEVICES) {
    if (typeof dev.bezel === 'number') {
      dev.bezel = { t: dev.bezel, r: dev.bezel, b: dev.bezel, l: dev.bezel };
    }
    dev.safeTop = dev.safeTop || 0;
    dev.safeBottom = dev.safeBottom || 0;
    dev.safeSide = dev.safeSide || 0;
    dev.radius = dev.radius || 0;
    dev.cutout = dev.cutout || 'none';
    dev.cw = dev.cw || 0;
    dev.ch = dev.ch || 0;
    dev.ct = dev.ct || 0;
    dev.buttons = dev.buttons || [];
    dev.homeButton = !!dev.homeButton;
    dev.finishes = dev.finishes || ['graphite'];
  }

  /*
   * Panel density, as the maker publishes it.
   *
   * This is what turns points into millimetres, and millimetres are what let the
   * frame be drawn at its true physical size on a real monitor:
   *
   *   mm per point = devicePixelRatio × 25.4 / ppi
   *
   * A 3x iPhone at 460 ppi puts 0.1657 mm behind every point, so its 402-point
   * screen is 66.6 mm across — which is what you measure on the real phone.
   */
  const PPI = {
    'iphone-se-3': 326, 'iphone-8-plus': 401,
    'iphone-x': 458, 'iphone-11': 326, 'iphone-11-pro-max': 458,
    'iphone-12-mini': 476, 'iphone-12': 460, 'iphone-12-pro-max': 458,
    'iphone-13-mini': 476, 'iphone-13': 460, 'iphone-13-pro-max': 458,
    'iphone-14': 460, 'iphone-14-plus': 458, 'iphone-14-pro': 460, 'iphone-14-pro-max': 460,
    'iphone-15': 461, 'iphone-15-plus': 460, 'iphone-15-pro': 461, 'iphone-15-pro-max': 460,
    'iphone-16': 460, 'iphone-16-plus': 460, 'iphone-16-pro': 460, 'iphone-16-pro-max': 460,
    'iphone-16e': 460, 'iphone-air': 460,
    'iphone-17': 460, 'iphone-17-pro': 460, 'iphone-17-pro-max': 460,

    // Samsung ships its big phones rendering below the panel's native resolution
    // (FHD+ on a QHD+ panel), so the density that matters here is the one at the
    // resolution the browser actually gets — not the marketing ppi.
    'galaxy-s8': 426, 'galaxy-s21': 421, 'galaxy-s22': 425, 'galaxy-s23': 425,
    'galaxy-s24': 416, 'galaxy-s24-plus': 385, 'galaxy-s24-ultra': 386,
    'galaxy-s25': 416, 'galaxy-s25-ultra': 386, 'galaxy-a55': 390,
    'galaxy-z-fold6-inner': 374, 'galaxy-z-fold5-cover': 410, 'galaxy-z-flip6': 425,

    'pixel-5': 432, 'pixel-6-pro': 512, 'pixel-7': 416, 'pixel-7-pro': 512,
    'pixel-8': 428, 'pixel-8-pro': 489, 'pixel-9': 422, 'pixel-9-pro': 495,
    'pixel-9-pro-xl': 486,
    'oneplus-12': 510, 'xiaomi-14': 527, 'nothing-phone-2': 394,

    'ipad-mini-7': 326, 'ipad-9': 264, 'ipad-11': 264,
    'ipad-air-11': 264, 'ipad-air-13': 264,
    'ipad-pro-11-m4': 264, 'ipad-pro-11-gen4': 264, 'ipad-pro-12-9': 264, 'ipad-pro-13-m4': 264,

    'macbook-air-13': 224, 'macbook-air-15': 224, 'macbook-pro-13': 227,
    'macbook-pro-14': 254, 'macbook-pro-16': 254,
    'imac-24': 218, 'studio-display': 218, 'pro-display-xdr': 218,
    'desktop-1080': 96, 'desktop-1440': 96, custom: 326,
  };

  /** When a density is unknown, the pixel ratio is the best predictor of it. */
  function fallbackPpi(dev) {
    if (dev.kind === 'tablet') return 264;
    if (dev.kind === 'laptop' || dev.kind === 'desktop') return dev.dpr > 1 ? 224 : 96;
    if (dev.dpr >= 3) return 460;
    if (dev.dpr >= 2.5) return 400;
    if (dev.dpr >= 2) return 326;
    return 96;
  }

  /**
   * Real dimensions in millimetres, from the manufacturers' own spec sheets.
   *
   *   body   the whole product, width × height
   *   screen the ACTIVE DISPLAY AREA — derived from the physical panel, which is not
   *          always the render buffer: an iPhone 8 Plus renders 1242×2208 into a
   *          1080×1920 panel, and Samsung ships its big phones rendering below native
   *   r      the radius of the physical body corner
   *
   * Together these make the frame true rather than approximate: the screen size fixes
   * how many millimetres a point is worth, and the leftover is the bezel — measured,
   * not eyeballed.
   */
  const PHYSICAL = {
    'galaxy-a55': { body: [77.4, 161.1], screen: [70.34, 152.4], r: 10 },
    'galaxy-s21': { body: [71.2, 151.7], screen: [65.16, 144.8], r: 10.5 },
    'galaxy-s22': { body: [70.6, 146], screen: [64.55, 139.85], r: 10.5 },
    'galaxy-s23': { body: [70.9, 146.3], screen: [64.55, 139.85], r: 10.5 },
    'galaxy-s24': { body: [70.6, 147], screen: [65.94, 142.88], r: 9.5 },
    'galaxy-s24-plus': { body: [75.9, 158.5], screen: [71.3, 154.48], r: 10 },
    'galaxy-s24-ultra': { body: [79, 162.3], screen: [72.43, 156.93], r: 4.5 },
    'galaxy-s25': { body: [70.5, 146.9], screen: [65.94, 142.88], r: 9.5 },
    'galaxy-s25-ultra': { body: [77.6, 162.8], screen: [73.45, 159.13], r: 8 },
    'galaxy-s8': { body: [68.1, 148.9], screen: [64.17, 131.9], r: 12 },
    'galaxy-z-flip6': { body: [71.9, 165.1], screen: [64.39, 157.41], r: 9 },
    'galaxy-z-fold5-cover': { body: [67.1, 154.9], screen: [57.12, 146.33], r: 6 },
    'galaxy-z-fold6-inner': { body: [129.9, 154.9], screen: [123.39, 148.18], r: 6 },
    'imac-24': { body: [547, 374], screen: [521.98, 293.61], r: 13 },
    'ipad-11': { body: [179.5, 248.6], screen: [157.79, 227.06], r: 14.3 },
    'ipad-9': { body: [174.1, 250.6], screen: [155.86, 207.82], r: 13 },
    'ipad-air-11': { body: [178.5, 247.6], screen: [157.79, 227.06], r: 13.8 },
    'ipad-air-13': { body: [214.9, 280.6], screen: [197.04, 262.85], r: 12.4 },
    'ipad-mini-7': { body: [134.8, 195.4], screen: [115.94, 176.55], r: 12.8 },
    'ipad-pro-11-gen4': { body: [178.5, 247.6], screen: [160.48, 229.75], r: 12.5 },
    'ipad-pro-11-m4': { body: [177.5, 249.7], screen: [160.48, 232.83], r: 12.5 },
    'ipad-pro-12-9': { body: [214.9, 280.6], screen: [197.04, 262.85], r: 12.4 },
    'ipad-pro-13-m4': { body: [215.5, 281.6], screen: [198.58, 264.78], r: 12.5 },
    'iphone-11': { body: [75.7, 150.9], screen: [64.51, 139.62], r: 12.06 },
    'iphone-11-pro-max': { body: [77.8, 158], screen: [68.88, 149.07], r: 10.95 },
    'iphone-12': { body: [71.5, 146.7], screen: [64.6, 139.81], r: 11.29 },
    'iphone-12-mini': { body: [64.2, 131.5], screen: [57.63, 124.87], r: 10.33 },
    'iphone-12-pro-max': { body: [78.1, 160.8], screen: [71.21, 154.06], r: 12.32 },
    'iphone-13': { body: [71.5, 146.7], screen: [64.6, 139.81], r: 11.29 },
    'iphone-13-mini': { body: [64.2, 131.5], screen: [57.63, 124.87], r: 10.33 },
    'iphone-13-pro-max': { body: [78.1, 160.8], screen: [71.21, 154.06], r: 12.32 },
    'iphone-14': { body: [71.5, 146.7], screen: [64.6, 139.81], r: 11.29 },
    'iphone-14-plus': { body: [78.1, 160.8], screen: [71.21, 154.06], r: 12.32 },
    'iphone-14-pro': { body: [71.5, 147.5], screen: [65.1, 141.14], r: 12.31 },
    'iphone-14-pro-max': { body: [77.6, 160.7], screen: [71.23, 154.39], r: 12.3 },
    'iphone-15': { body: [71.6, 147.6], screen: [65.1, 141.14], r: 12.36 },
    'iphone-15-plus': { body: [77.8, 160.9], screen: [71.23, 154.39], r: 12.4 },
    'iphone-15-pro': { body: [70.6, 146.6], screen: [65.1, 141.14], r: 11.86 },
    'iphone-15-pro-max': { body: [76.7, 159.9], screen: [71.23, 154.39], r: 11.85 },
    'iphone-16': { body: [71.6, 147.6], screen: [65.1, 141.14], r: 12.36 },
    'iphone-16-plus': { body: [77.8, 160.9], screen: [71.23, 154.39], r: 12.4 },
    'iphone-16-pro': { body: [71.5, 149.6], screen: [66.59, 144.78], r: 12.72 },
    'iphone-16-pro-max': { body: [77.6, 163], screen: [72.89, 158.36], r: 12.63 },
    'iphone-16e': { body: [71.5, 146.7], screen: [64.6, 139.81], r: 11.29 },
    'iphone-17': { body: [71.5, 149.6], screen: [66.59, 144.78], r: 12.72 },
    'iphone-17-pro': { body: [71.9, 150], screen: [66.59, 144.78], r: 12.92 },
    'iphone-17-pro-max': { body: [78, 163.4], screen: [72.89, 158.36], r: 12.83 },
    'iphone-8-plus': { body: [78.1, 158.4], screen: [68.41, 121.62], r: 10.9 },
    'iphone-air': { body: [74.7, 156.2], screen: [69.57, 151.07], r: 12.83 },
    'iphone-se-3': { body: [67.3, 138.4], screen: [58.44, 103.94], r: 9.4 },
    'iphone-x': { body: [70.9, 143.6], screen: [62.39, 135.1], r: 10.74 },
    'macbook-air-13': { body: [304.1, 215], screen: [290.29, 188.69], r: 8.5 },
    'macbook-air-15': { body: [340.4, 237.6], screen: [326.57, 211.36], r: 9 },
    'macbook-pro-13': { body: [304.1, 212.4], screen: [286.45, 179.03], r: 8.5 },
    'macbook-pro-14': { body: [312.6, 221.2], screen: [302.4, 196.4], r: 9 },
    'macbook-pro-16': { body: [355.7, 248.1], screen: [345.6, 223.4], r: 10 },
    'nothing-phone-2': { body: [76.4, 162.1], screen: [69.62, 155.49], r: 12 },
    'oneplus-12': { body: [75.8, 164.3], screen: [71.72, 157.78], r: 12 },
    'pixel-5': { body: [70.4, 144.7], screen: [63.5, 137.58], r: 11 },
    'pixel-6-pro': { body: [75.9, 163.9], screen: [71.44, 154.78], r: 12 },
    'pixel-7': { body: [73.2, 155.6], screen: [65.94, 146.54], r: 11 },
    'pixel-7-pro': { body: [76.6, 162.9], screen: [71.44, 154.78], r: 12 },
    'pixel-8': { body: [70.8, 150.5], screen: [64.09, 142.43], r: 14 },
    'pixel-8-pro': { body: [76.5, 162.6], screen: [69.81, 155.41], r: 15 },
    'pixel-9': { body: [72, 152.8], screen: [65, 145.9], r: 13 },
    'pixel-9-pro': { body: [72, 152.8], screen: [65.68, 146.55], r: 13 },
    'pixel-9-pro-xl': { body: [76.6, 162.8], screen: [70.24, 156.37], r: 14 },
    'pro-display-xdr': { body: [718, 412], screen: [700.95, 394.28], r: 10 },
    'studio-display': { body: [623, 362], screen: [596.55, 335.56], r: 11 },
    'xiaomi-14': { body: [71.5, 152.8], screen: [66.26, 147.43], r: 11 },
  };

  const LEGACY_BODY_MM = {
    'iphone-17-pro-max': [78.0, 163.4], 'iphone-17-pro': [71.9, 150.0],
    'iphone-17': [71.5, 149.6], 'iphone-air': [74.7, 156.2],
    'iphone-16-pro-max': [77.6, 163.0], 'iphone-16-pro': [71.5, 149.6],
    'iphone-16-plus': [77.8, 160.9], 'iphone-16': [71.6, 147.6],
    'iphone-16e': [71.5, 146.7],
    'iphone-15-pro-max': [76.7, 159.9], 'iphone-15-pro': [70.6, 146.6],
    'iphone-15-plus': [77.8, 160.9], 'iphone-15': [71.6, 147.6],
    'iphone-14-pro-max': [77.6, 160.7], 'iphone-14-pro': [71.5, 147.5],
    'iphone-14-plus': [78.1, 160.8], 'iphone-14': [71.5, 146.7],
    'iphone-13-pro-max': [78.1, 160.8], 'iphone-13': [71.5, 146.7],
    'iphone-13-mini': [64.2, 131.5],
    'iphone-12-pro-max': [78.1, 160.8], 'iphone-12': [71.5, 146.7],
    'iphone-12-mini': [64.2, 131.5],
    'iphone-11-pro-max': [77.8, 158.0], 'iphone-11': [75.7, 150.9],
    'iphone-x': [70.9, 143.6],
    'iphone-se-3': [67.3, 138.4], 'iphone-8-plus': [78.1, 158.4],

    'galaxy-s25-ultra': [77.6, 162.8], 'galaxy-s25': [70.5, 146.9],
    'galaxy-s24-ultra': [79.0, 162.3], 'galaxy-s24-plus': [75.9, 158.5],
    'galaxy-s24': [70.6, 147.0], 'galaxy-s23': [70.9, 146.3],
    'galaxy-s22': [70.6, 146.0], 'galaxy-s21': [71.2, 151.7],
    'galaxy-a55': [76.5, 161.1], 'galaxy-s8': [68.1, 148.9],
    'galaxy-z-fold6-inner': [132.6, 153.5], 'galaxy-z-fold5-cover': [67.1, 154.9],
    'galaxy-z-flip6': [71.9, 165.1],

    'pixel-9-pro-xl': [76.6, 162.8], 'pixel-9-pro': [72.0, 152.8],
    'pixel-9': [72.0, 152.8], 'pixel-8-pro': [76.5, 162.6],
    'pixel-8': [70.8, 150.5], 'pixel-7-pro': [76.6, 162.9],
    'pixel-7': [73.2, 155.6], 'pixel-6-pro': [75.9, 163.9],
    'pixel-5': [70.4, 144.7],
    'oneplus-12': [75.8, 164.3], 'xiaomi-14': [71.5, 152.8],
    'nothing-phone-2': [76.4, 162.1],

    'ipad-pro-13-m4': [215.5, 281.6], 'ipad-pro-11-m4': [177.5, 249.7],
    'ipad-pro-11-gen4': [178.5, 247.6], 'ipad-pro-12-9': [214.9, 280.6],
    'ipad-air-13': [214.9, 280.6], 'ipad-air-11': [178.5, 247.6],
    'ipad-11': [179.5, 248.6], 'ipad-mini-7': [134.8, 195.4],
    'ipad-9': [174.1, 250.6],

    'macbook-pro-16': [355.7, 248.1], 'macbook-pro-14': [312.6, 221.2],
    'macbook-air-15': [340.4, 237.6], 'macbook-air-13': [304.1, 215.0],
    'macbook-pro-13': [304.1, 212.4],
    // Desktop displays are deliberately absent: their published height includes the
    // stand, so subtracting the panel from it would invent an enormous chin.
  };

  for (const dev of DEVICES) {
    const phys = PHYSICAL[dev.id];

    if (phys && phys.screen) {
      // Measured panel width divided by the points it presents: exact, and it does
      // not care whether the device renders at its panel's native resolution.
      dev.mmPerPt = phys.screen[0] / dev.w;
      dev.ppi = Math.round((dev.dpr * 25.4) / dev.mmPerPt);
    } else {
      dev.ppi = PPI[dev.id] || fallbackPpi(dev);
      dev.mmPerPt = (dev.dpr * 25.4) / dev.ppi;
    }

    const body = phys ? phys.body : LEGACY_BODY_MM[dev.id];
    if (!body) {
      dev.bodyMm = null;
      continue;
    }

    dev.bodyMm = { w: body[0], h: body[1], r: (phys && phys.r) || null };
    const screenW = phys && phys.screen ? phys.screen[0] : dev.w * dev.mmPerPt;
    const screenH = phys && phys.screen ? phys.screen[1] : dev.h * dev.mmPerPt;
    const sideMm = (body[0] - screenW) / 2;
    const vertMm = body[1] - screenH;

    // A spec sheet that disagrees with the panel size by this much is the wrong
    // number, not a real bezel; keep the hand-set values rather than draw nonsense.
    // Phones and tablets sit between about 1 and 25 mm; anything outside that means
    // the body figure and the panel figure are not describing the same thing.
    const maxBezel = dev.kind === 'phone' ? 12 : 30;
    if (!(sideMm > 0.3 && sideMm < maxBezel && vertMm > 0.4 && vertMm / 2 < maxBezel * 3)) {
      dev.bodyMm = null;
      continue;
    }

    // Split the vertical leftover the way the hand-set frame did, so a home-button
    // phone keeps its forehead-and-chin proportions instead of becoming symmetric.
    const ratio = dev.bezel.t / (dev.bezel.t + dev.bezel.b || 1);
    const side = sideMm / dev.mmPerPt;
    dev.bezel = {
      l: round1(side),
      r: round1(side),
      t: round1((vertMm * ratio) / dev.mmPerPt),
      b: round1((vertMm * (1 - ratio)) / dev.mmPerPt),
    };

    // The body corner in points, so the frame's outer rounding is the real one
    // rather than "screen radius plus bezel".
    if (dev.bodyMm.r) dev.bodyRadius = round1(dev.bodyMm.r / dev.mmPerPt);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  const BY_ID = new Map(DEVICES.map(x => [x.id, x]));

  const GROUP_ORDER = ['Apple', 'Samsung', 'Google', 'OnePlus', 'Xiaomi', 'Nothing', 'Custom'];
  const KIND_LABEL = { phone: 'iPhone', tablet: 'iPad', laptop: 'Mac', desktop: 'Display' };

  /** Groups for pickers: Apple splits by kind, everyone else by brand. */
  function groups() {
    const out = new Map();
    for (const dev of DEVICES) {
      const key = dev.brand === 'Apple' ? KIND_LABEL[dev.kind] || 'Apple' : dev.brand;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(dev);
    }
    const sorted = [...out.entries()].sort((a, b) => {
      const brandOf = k => (['iPhone', 'iPad', 'Mac', 'Display'].includes(k) ? 'Apple' : k);
      const ia = GROUP_ORDER.indexOf(brandOf(a[0]));
      const ib = GROUP_ORDER.indexOf(brandOf(b[0]));
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a[0].localeCompare(b[0]);
    });
    return sorted.map(([name, items]) => ({ name, items }));
  }

  function byId(id) {
    return BY_ID.get(id) || BY_ID.get('iphone-16-pro') || DEVICES[0];
  }

  /** Portrait metrics flipped into landscape, safe areas included. */
  function oriented(dev, orientation, custom) {
    const base = dev.id === 'custom' && custom
      ? Object.assign({}, dev, { w: custom.w, h: custom.h, dpr: custom.dpr || dev.dpr })
      : dev;
    if (orientation !== 'landscape') return Object.assign({}, base);
    return Object.assign({}, base, {
      w: base.h,
      h: base.w,
      landscape: true,
      /*
       * In landscape iOS moves the cutout to the left edge and shortens the top inset
       * to the plain status-bar height; the home indicator stays at the bottom.
       *
       * A tablet is the exception: it has no notch to move, keeps its status bar
       * across the top in both orientations, and so keeps its top inset. Zeroing it
       * drew every landscape iPad layout with its header too high — and landscape is
       * the orientation an iPad is mostly used in.
       */
      safeTop: base.homeButton || base.kind === 'tablet' ? base.safeTop : 0,
      safeBottom: base.safeBottom ? 21 : 0,
      safeSide: base.safeSide || 0,
      bezel: { t: base.bezel.l, r: base.bezel.t, b: base.bezel.r, l: base.bezel.b },
      buttons: base.buttons.map(b => ({
        ...b,
        side: { left: 'bottom', right: 'top', top: 'left', bottom: 'right' }[b.side] || b.side,
      })),
    });
  }

  /**
   * Which pointer belongs over this device.
   *
   * "auto" is the honest default: a fingertip over anything you touch, an arrow
   * over anything you drive with a mouse. Both hosts share this so they cannot
   * disagree about what counts as a phone.
   */
  function pointerFor(setting, device) {
    const mode = setting || 'auto';
    if (mode !== 'auto') return mode;
    return device && (device.kind === 'phone' || device.kind === 'tablet') ? 'finger' : 'arrow';
  }

  return { DEVICES, byId, groups, oriented, pointerFor, KIND_LABEL };
});
