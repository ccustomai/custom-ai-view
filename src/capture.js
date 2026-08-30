/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Screenshots and screen recording.
 *
 * A webview cannot photograph its own cross-origin frame — canvas cannot read it and
 * there is no API that will. So a headless Chrome loads the *same* capture page over
 * the *same* proxy with the *same* device CSS, and photographs that. What comes back
 * is the device frame exactly as the panel draws it, at full resolution.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { HeadlessBrowser } = require('./cdp.js');
const { encodeGif } = require('./gif.js');

/** How much of the capture page each mode keeps. */
const MODES = new Set(['frame', 'screen', 'page', 'element', 'full']);

class Capturer {
  /**
   * @param {{proxy: import('./proxy.js').PreviewProxy, log?: (m: string) => void, chromePath?: string}} opts
   */
  constructor(opts) {
    this.proxy = opts.proxy;
    this.log = opts.log || (() => {});
    this.browser = new HeadlessBrowser({ chromePath: opts.chromePath, log: this.log });
    this.outDir = opts.outDir || path.join(os.tmpdir(), 'custom-ai-view-shots');
    /** The take in progress, if any — see startRecording. */
    this.recording = null;
    /** Where finished material is filed, once a host hands one over. */
    this.library = opts.library || null;
  }

  /**
   * Save a capture where it belongs: filed by site in the library when there is
   * one, otherwise in the scratch folder.
   */
  _file(buffer, url, kind, name, ext) {
    if (this.library && url) {
      try {
        return this.library.save(url, kind, name, ext, buffer);
      } catch (err) {
        this.log('could not file into the library: ' + err.message);
      }
    }
    return this._save(buffer, name, ext);
  }

  get available() {
    return this.browser.available;
  }

  dispose() {
    this.browser.stop();
  }

  /** Build the capture-page URL, which lives on the proxy so it can reach the shim. */
  shotUrl(opts) {
    const p = new URLSearchParams();
    p.set('device', opts.device || 'iphone-16-pro');
    p.set('orientation', opts.orientation || 'portrait');
    p.set('mode', opts.mode || 'frame');
    if (opts.url) p.set('url', this.proxy.wrap(opts.url));
    if (opts.url) p.set('real', opts.url);
    if (opts.selector) p.set('selector', opts.selector);
    if (opts.describe) p.set('describe', '1');
    if (opts.finish) p.set('finish', opts.finish);
    if (opts.statusBar) p.set('statusBar', opts.statusBar);
    if (opts.statusBarLayout) p.set('statusBarLayout', opts.statusBarLayout);
    if (opts.clock) p.set('clock', opts.clock);
    p.set('chrome', opts.browserChrome ? '1' : '0');
    p.set('label', opts.showLabel ? '1' : '0');
    p.set('glare', opts.glare === false ? '0' : '1');
    if (opts.background) p.set('bg', opts.background);
    if (opts.custom) {
      p.set('cw', String(opts.custom.w));
      p.set('ch', String(opts.custom.h));
      p.set('cd', String(opts.custom.dpr));
    }
    return `${this.proxy.origin}/${this.proxy.token}/__dp/shot.html?${p.toString()}`;
  }

  /**
   * @returns {Promise<{buffer: Buffer, width: number, height: number, file: string}>}
   */
  async shot(opts) {
    const mode = MODES.has(opts.mode) ? opts.mode : 'frame';
    const scale = Math.min(4, Math.max(1, opts.scale || 2));

    await this.proxy.start();
    const page = await this.browser.newPage();

    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');

      if (mode === 'full') {
        return await this._captureFullPage(page, opts, scale);
      }

      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1400,
        height: 1200,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const target = this.shotUrl(Object.assign({}, opts, { mode }));
      await this._navigate(page, target);
      await this._waitReady(page);

      const size = await this._eval(page, 'window.__SHOT_SIZE__');
      if (size && size.width) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          deviceScaleFactor: 1,
          mobile: false,
        });
        // Re-read after the resize; layout may have shifted.
        await this._sleep(120);
      }

      const rects = await this._eval(page, 'window.__SHOT_RECTS__()');
      const clip = rects && rects[mode === 'element' ? 'element' : mode];
      if (!clip || !clip.width) {
        if (mode === 'element') throw new Error('The selected element was not found on the captured page.');
        throw new Error('Could not measure the device frame to capture.');
      }

      const shot = await page.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: {
            x: Math.max(0, clip.x),
            y: Math.max(0, clip.y),
            width: Math.ceil(clip.width),
            height: Math.ceil(clip.height),
            scale,
          },
        },
        60000
      );

      const buffer = Buffer.from(shot.data, 'base64');
      // An agent looking at the page already has the picture inline; writing a copy
      // for every glance turns the person's Desktop into a spool directory.
      const file = opts.file === false
        ? ''
        : this._file(buffer, opts.url, 'screenshots', opts.name || mode, '.png');
      return {
        buffer,
        file,
        width: Math.round(clip.width * scale),
        height: Math.round(clip.height * scale),
        mode,
      };
    } finally {
      await this.browser.closePage(page);
    }
  }

  /** Whole scrollable page at the device viewport, without the frame around it. */
  async _captureFullPage(page, opts, scale) {
    const { byId, oriented } = require('./devices.js');
    const device = oriented(byId(opts.device), opts.orientation, opts.custom);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: device.w,
      height: device.h,
      deviceScaleFactor: device.dpr,
      mobile: true,
      screenWidth: device.w,
      screenHeight: device.h,
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});

    await this._navigate(page, this.proxy.wrap(opts.url));
    await this._sleep(700);

    const metrics = await page.send('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize;
    const height = Math.min(Math.ceil(content.height), 20000);

    const shot = await page.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: device.w, height, scale },
      },
      90000
    );

    const buffer = Buffer.from(shot.data, 'base64');
    return {
      buffer,
      file: opts.file === false
        ? ''
        : this._file(buffer, opts.url, 'screenshots', opts.name || 'full', '.png'),
      width: Math.round(device.w * scale),
      height: Math.round(height * scale),
      mode: 'full',
    };
  }

  /**
   * Read one element out of the previewed page: markup, computed styles, box, path.
   * Runs in the headless capture page, so it works whether or not a panel is open.
   */
  async describe(opts) {
    await this.proxy.start();
    const page = await this.browser.newPage();
    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false,
      });

      await this._navigate(page, this.shotUrl(Object.assign({}, opts, { mode: 'frame', describe: true })));
      await this._waitReady(page);

      // The shim answers asynchronously; give it a moment past page-ready.
      const deadline = Date.now() + 4000;
      for (;;) {
        const found = await this._eval(page, 'window.__SHOT_ELEMENT__ || null');
        if (found) return found;
        if (Date.now() > deadline) break;
        await this._sleep(150);
      }
      throw new Error(
        'No element matched. The page must be loaded through the proxy for inspection to work.'
      );
    } finally {
      await this.browser.closePage(page);
    }
  }

  /**
   * Start recording and keep going until told to stop.
   *
   * Frames go to disk as they arrive rather than piling up in memory: at ten frames
   * a second a phone-sized PNG is a couple of hundred kilobytes, so a ten-minute
   * take would be over a gigabyte held in RAM. On disk the only limit is the disk.
   *
   * @param {{fps?: number, name?: string}} opts
   */
  async startRecording(opts) {
    if (this.recording) throw new Error('Already recording.');

    const fps = Math.min(20, Math.max(2, opts.fps || 10));
    await this.proxy.start();
    const page = await this.browser.newPage();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-ai-view-rec-'));

    const session = {
      page,
      dir,
      fps,
      opts,
      frames: 0,
      bytes: 0,
      started: Date.now(),
      stopping: false,
      warned: false,
    };
    this.recording = session;

    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false,
      });

      await this._navigate(page, this.shotUrl(Object.assign({}, opts, { mode: 'frame' })));
      await this._waitReady(page);

      const size = await this._eval(page, 'window.__SHOT_SIZE__');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(size.width), height: Math.ceil(size.height),
        deviceScaleFactor: 1, mobile: false,
      });
      await this._sleep(150);

      const rects = await this._eval(page, 'window.__SHOT_RECTS__()');
      session.clip = rects.frame;
      if (!session.clip || !session.clip.width) throw new Error('Could not measure the device to record.');

      session.loop = this._recordLoop(session);
      this.log('recording started at ' + fps + ' fps into ' + dir);
      return { fps, started: session.started };
    } catch (err) {
      this.recording = null;
      await this.browser.closePage(page);
      throw err;
    }
  }

  async _recordLoop(session) {
    const interval = 1000 / session.fps;
    while (!session.stopping) {
      const began = Date.now();
      try {
        const shot = await session.page.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: {
            x: Math.max(0, session.clip.x), y: Math.max(0, session.clip.y),
            width: Math.ceil(session.clip.width), height: Math.ceil(session.clip.height),
            scale: 1,
          },
        }, 30000);
        const buffer = Buffer.from(shot.data, 'base64');
        fs.writeFileSync(
          path.join(session.dir, String(session.frames).padStart(6, '0') + '.png'),
          buffer
        );
        session.frames++;
        session.bytes += buffer.length;

        // A GIF assembled from tens of thousands of frames is unusable and the
        // encode would take longer than the recording. Say so once.
        if (!session.warned && session.frames > 6000) {
          session.warned = true;
          this.log('recording is very long (' + session.frames + ' frames) — consider stopping');
        }
      } catch (err) {
        if (!session.stopping) this.log('dropped a frame: ' + err.message);
        break;
      }
      const spent = Date.now() - began;
      if (spent < interval) await this._sleep(interval - spent);
    }
  }

  /** Stop, encode what was captured, and clean up the frames on disk. */
  async stopRecording() {
    const session = this.recording;
    if (!session) throw new Error('Nothing is being recorded.');

    session.stopping = true;
    this.recording = null;
    try {
      await session.loop;
    } catch {
      /* the loop already reported why it ended */
    }
    await this.browser.closePage(session.page);

    if (!session.frames) {
      fs.rmSync(session.dir, { recursive: true, force: true });
      throw new Error('No frames were captured.');
    }

    this.log('encoding ' + session.frames + ' frames');
    const files = fs.readdirSync(session.dir).filter(f => f.endsWith('.png')).sort();
    const buffers = files.map(f => fs.readFileSync(path.join(session.dir, f)));
    const gif = encodeGif(buffers, { delayMs: Math.round(1000 / session.fps) });

    fs.rmSync(session.dir, { recursive: true, force: true });

    return {
      buffer: gif,
      file: this._file(gif, session.opts.url, 'recordings', session.opts.name || 'recording', '.gif'),
      frames: session.frames,
      fps: session.fps,
      seconds: Math.round((Date.now() - session.started) / 1000),
    };
  }

  get isRecording() {
    return !!this.recording;
  }

  recordingStatus() {
    if (!this.recording) return { recording: false };
    return {
      recording: true,
      frames: this.recording.frames,
      fps: this.recording.fps,
      seconds: Math.round((Date.now() - this.recording.started) / 1000),
      megabytes: Math.round(this.recording.bytes / 1024 / 1024 * 10) / 10,
    };
  }

  /**
   * Record for a fixed stretch. Kept for callers that know how long they want;
   * start/stop is the one with no limit.
   *
   * @param {{durationMs?: number, fps?: number}} opts
   */
  async record(opts) {
    const fps = Math.min(20, Math.max(2, opts.fps || 10));
    const duration = Math.max(500, opts.durationMs || 5000);

    await this.proxy.start();
    const page = await this.browser.newPage();

    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false,
      });

      await this._navigate(page, this.shotUrl(Object.assign({}, opts, { mode: 'frame' })));
      await this._waitReady(page);

      const size = await this._eval(page, 'window.__SHOT_SIZE__');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(size.width), height: Math.ceil(size.height),
        deviceScaleFactor: 1, mobile: false,
      });
      await this._sleep(150);

      const rects = await this._eval(page, 'window.__SHOT_RECTS__()');
      const clip = rects.frame;

      const frames = [];
      const wanted = Math.round((duration / 1000) * fps);
      const interval = 1000 / fps;

      /*
       * captureBeyondViewport is not set here, and that is the whole difference
       * between a recording and a slideshow.
       *
       * It forces a full-page re-render for every frame, which cost about a
       * second each. Twenty-five frames of a five-second clip therefore took
       * thirty seconds to collect — and the frames were then played back at the
       * requested rate, so five seconds of animation was sampled over thirty
       * and shown as though it had happened in five. The result was not slow;
       * it was wrong. Anything that moved was recorded at a sixth of its speed
       * and replayed at full speed, which is a different animation.
       *
       * The viewport was already resized to the frame above, so there is
       * nothing beyond it to capture.
       */
      const started = Date.now();
      let late = 0;
      for (let i = 0; i < wanted; i++) {
        const due = started + i * interval;
        const shot = await page.send('Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: Math.max(0, clip.x), y: Math.max(0, clip.y),
            width: Math.ceil(clip.width), height: Math.ceil(clip.height),
            scale: 1,
          },
        }, 30000);
        frames.push(Buffer.from(shot.data, 'base64'));
        const wait = due + interval - Date.now();
        if (wait > 0) await this._sleep(wait);
        else late++;
      }

      // If frames could not be taken as fast as they were asked for, the
      // playback rate is a fiction. Say so rather than letting the file imply a
      // speed it was never recorded at.
      const elapsed = Date.now() - started;
      const realFps = frames.length / (elapsed / 1000);
      if (late > wanted * 0.2) {
        this.log('recording fell behind on ' + late + ' of ' + wanted + ' frames — real rate '
          + realFps.toFixed(1) + ' fps, not ' + fps);
      }

      this.log(`recorded ${frames.length} frames in ${elapsed}ms, encoding gif`);
      // The delay is what actually happened, not what was asked for: a GIF
      // stamped 10 fps that was captured at 2 plays back six times too fast.
      const gif = encodeGif(frames, { delayMs: Math.round(1000 / Math.min(fps, Math.max(1, realFps))) });
      return {
        buffer: gif,
        file: this._file(gif, opts.url, 'recordings', opts.name || 'recording', '.gif'),
        frames: frames.length,
        fps,
        realFps: Math.round(realFps * 10) / 10,
        elapsedMs: elapsed,
      };
    } finally {
      await this.browser.closePage(page);
    }
  }

  // ------------------------------------------------------------ internals

  async _navigate(page, url) {
    const loaded = new Promise(resolve => {
      const done = () => resolve();
      page.on('Page.loadEventFired', done);
      setTimeout(done, 15000);
    });
    await page.send('Page.navigate', { url });
    await loaded;
  }

  async _waitReady(page, timeout = 12000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this._eval(page, 'window.__SHOT_STATE__ || null');
      if (state && state.ready) return state;
      if (Date.now() > deadline) return null;
      await this._sleep(120);
    }
  }

  async _eval(page, expression) {
    const result = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'capture page threw');
    }
    return result.result ? result.result.value : null;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  _save(buffer, name, ext) {
    try {
      fs.mkdirSync(this.outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(this.outDir, `${name}-${stamp}${ext || '.png'}`);
      fs.writeFileSync(file, buffer);
      return file;
    } catch (err) {
      this.log('could not save capture: ' + err.message);
      return '';
    }
  }
}

module.exports = { Capturer };
