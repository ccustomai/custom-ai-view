#!/usr/bin/env node
/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Custom AI View MCP server.
 *
 * Gives an AI agent the same view and the same controls the person has: it can open a URL
 * on a given device, take a screenshot and actually SEE it, read the markup and
 * computed styles of any element, and record what happens.
 *
 * Speaks MCP over stdio and forwards everything to the extension's control API,
 * which it discovers through ~/.custom-ai-view/control.json.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HANDSHAKE = path.join(os.homedir(), '.custom-ai-view', 'control.json');
const PROTOCOL_VERSION = '2024-11-05';

/** Read from the manifest, so it cannot drift from what is actually shipped. */
const VERSION = (() => {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch {
    return '0.0.0';
  }
})();

/** The standalone app, which sits next to this file in the same install. */
const APP_EXE = process.env.DP_APP_PATH || path.join(
  __dirname,
  '..',
  'dist',
  process.platform === 'win32' ? 'CustomAIView.exe' : 'CustomAIView'
);

// --------------------------------------------------------------- transport

function readHandshake() {
  let raw;
  try {
    raw = fs.readFileSync(HANDSHAKE, 'utf8');
  } catch {
    return null;
  }
  try {
    const info = JSON.parse(raw);
    return info.port && info.token ? info : null;
  } catch {
    return null;
  }
}

/** Is anything actually answering on the port the handshake names? */
function alive(info, timeout = 1500) {
  return new Promise(resolve => {
    if (!info) return resolve(false);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: '/state',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 2, authorization: 'Bearer ' + info.token },
      },
      res => {
        res.resume();
        resolve(res.statusCode < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
    req.write('{}');
    req.end();
  });
}

let starting = null;

/**
 * Make sure something is listening.
 *
 * A tool that answers "nothing is running, go open it yourself" is a tool that
 * cannot be used without a person. If the standalone app is installed, start it and
 * wait for it to announce itself; only fall back to asking when there is no app to
 * start — that is, when the extension inside VS Code is the only host.
 */
async function ensureRunning() {
  let info = readHandshake();
  if (await alive(info)) return info;

  if (!fs.existsSync(APP_EXE)) {
    throw new Error(
      'Custom AI View is not running, and the standalone app was not found at ' + APP_EXE + '. ' +
      'Open VS Code and run "Custom AI View: Open", then try again.'
    );
  }

  if (!starting) {
    starting = (async () => {
      const child = spawn(APP_EXE, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(APP_EXE),
      });
      child.unref();

      const deadline = Date.now() + 40000;
      for (;;) {
        await new Promise(r => setTimeout(r, 600));
        const candidate = readHandshake();
        if (await alive(candidate)) return candidate;
        if (Date.now() > deadline) throw new Error('Custom AI View did not start in time.');
      }
    })().finally(() => {
      starting = null;
    });
  }

  info = await starting;
  return info;
}

async function call(route, payload, timeoutMs = 120000) {
  const info = await ensureRunning();
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: route,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          authorization: 'Bearer ' + info.token,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new Error('Custom AI View returned a non-JSON response: ' + text.slice(0, 200)));
          }
          if (res.statusCode >= 400 || parsed.error) {
            return reject(new Error(parsed.error || 'Custom AI View error ' + res.statusCode));
          }
          resolve(parsed);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(route + ' timed out')));
    req.on('error', err =>
      reject(
        new Error(
          err.code === 'ECONNREFUSED'
            ? 'Custom AI View is not listening. Is the VS Code window still open?'
            : err.message
        )
      )
    );
    req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------ tools

const DEVICE_ARG = {
  type: 'string',
  description: 'Device id, e.g. iphone-16-pro, galaxy-s24, ipad-pro-11-m4. Omit to keep the current one.',
};

/*
 * Several windows can be open at once — a phone and an iPad side by side is the
 * whole reason the app supports it. Without a way to name one, every call lands on
 * whichever opened first, and comparing two devices means driving one window back
 * and forth and losing the screen each time.
 */
const WINDOW_ARG = {
  type: 'string',
  description: 'Which window to act on; custom_ai_view_state lists the ids. Omit for the first one.',
};

const TOOLS = [
  {
    name: 'custom_ai_view_state',
    description:
      'What the Custom AI View browser is showing right now: current URL, device, viewport size, ' +
      'orientation, whether it is proxied, and the element the user currently has selected.',
    inputSchema: { type: 'object', properties: { window: WINDOW_ARG }, additionalProperties: false },
    // Pass the arguments on. Dropping them meant a question about the second
    // window was answered with the first window's URL, device and selection,
    // and nothing said so.
    run: args => call('/state', args).then(state => ({ text: JSON.stringify(state, null, 2) })),
  },
  {
    name: 'custom_ai_view_devices',
    description: 'List every device in the catalogue with its viewport size, pixel ratio and safe areas.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Substring to match against name or id.' } },
      additionalProperties: false,
    },
    run: args => call('/devices', args).then(r => ({ text: JSON.stringify(r.devices, null, 1) })),
  },
  {
    name: 'custom_ai_view_open',
    description:
      'Open a URL in the Custom AI View browser, optionally switching device and orientation. ' +
      'Accepts a full URL, a bare host, or just a port number for a local dev server.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, host, or port number.' },
        device: DEVICE_ARG,
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: args => call('/open', args).then(r => ({ text: 'Opened ' + r.url + ' on ' + r.device + '.' })),
  },
  {
    name: 'custom_ai_view_screenshot',
    description:
      'Take a screenshot and return the image, so you can see the page exactly as it renders on the ' +
      'device. Modes: frame (the whole device), screen (inside the bezels), page (just the viewport), ' +
      'full (the entire scrollable page), element (one element, ringed).\n' +
      'By default this photographs the OPEN WINDOW — the user\'s own session, scroll position and any ' +
      'live edits. Passing url, device, orientation, or mode "full" cannot come from that window, so ' +
      'those render a fresh copy in a throwaway browser profile: signed out, at the top of the page. ' +
      'The answer says which one you got. If it says "a fresh copy", do not describe it as the user\'s ' +
      'screen — a login page is what a signed-out render of a private screen looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['frame', 'screen', 'page', 'full', 'element'] },
        url: { type: 'string', description: 'Capture this URL instead of the one on screen. Renders signed out.' },
        device: DEVICE_ARG,
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        selector: { type: 'string', description: 'CSS selector, required for mode "element".' },
        scale: { type: 'number', description: 'Pixel density of the capture, 1 to 4. Default 2.' },
        window: WINDOW_ARG,
        save: {
          type: 'boolean',
          description: 'Also write a PNG into the site folder. Default false: the image is already ' +
            'inline here, and saving every look fills the user\'s Desktop with files nobody asked for.',
        },
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/screenshot', Object.assign({ inline: true, file: args.save === true }, args));
      // Which browser took the picture is the difference between the user's screen and
      // a stranger's, so it is stated rather than left to be assumed.
      const provenance = r.live
        ? 'the open window, with the user\'s session'
        : 'a fresh copy, signed out' +
          (r.liveFailed ? ' — the open window could not be captured: ' + r.liveFailed : '');
      return {
        text:
          'Screenshot ' + r.width + '×' + r.height + ' (' + r.mode + ') — ' + provenance +
          (r.file ? '\nSaved to ' + r.file : ''),
        image: r.data ? { data: r.data, mimeType: 'image/png' } : null,
      };
    },
  },
  {
    name: 'custom_ai_view_inspect',
    description:
      'Read one element on the previewed page: its markup, computed styles, box, and position in the ' +
      'tree. Use the selector the user picked (custom_ai_view_state reports it) or any CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector. Omit to use the user\'s current selection.' },
        url: { type: 'string' },
        device: DEVICE_ARG,
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/inspect', args);
      return { text: r.report };
    },
  },
  {
    name: 'custom_ai_view_find',
    description:
      'Search the previewed page for elements, by CSS selector or by the text they show. ' +
      'Returns each match with a selector you can pass to inspect, screenshot, click or edit. ' +
      'Use this when you know what the user is pointing at but not what it is called in the code.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to match.' },
        text: { type: 'string', description: 'Visible text to look for, instead of a selector.' },
        limit: { type: 'number', description: 'Maximum matches, default 20.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/find', args);
      if (!r.matches || !r.matches.length) return { text: 'Nothing matched.' };
      return {
        text: r.matches
          .map(m =>
            m.name + '\n  selector: ' + m.selector +
            // Where it is, not only how big — the difference between the button and
            // the carousel's spare copy of it parked off the left edge.
            '\n  box: ' + Math.round(m.rect.width) + ' × ' + Math.round(m.rect.height) +
            ' at (' + Math.round(m.rect.x) + ', ' + Math.round(m.rect.y) + ')' +
            (m.offscreen ? '  — OFF SCREEN, tapping it does nothing a person could see'
              : m.visible ? '' : '  — not visible (hidden, or transparent)') +
            (m.text ? '\n  text: ' + m.text : '')
          )
          .join('\n\n'),
      };
    },
  },
  {
    name: 'custom_ai_view_tree',
    description:
      'Read the element tree of the previewed page, one level at a time. Omit path for the ' +
      'root; pass the path of a node to list its children. Paths are arrays of child indices.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'array',
          items: { type: 'number' },
          description: 'Child-index path from <html>. Omit for the top level.',
        },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/tree', args);
      const lines = (r.children || []).map(n => {
        const cls = n.classes && n.classes.length ? '.' + n.classes.join('.') : '';
        return '[' + (n.path || []).join(',') + '] <' + n.tag + (n.id ? '#' + n.id : '') + cls + '> ' +
          n.w + '×' + n.h + (n.kids ? '  (' + n.kids + ' children)' : '') +
          (n.text ? '  "' + n.text + '"' : '');
      });
      if (r.truncated) lines.push('… ' + r.truncated + ' more siblings not listed');
      return { text: lines.length ? lines.join('\n') : 'No child elements.' };
    },
  },
  {
    name: 'custom_ai_view_edit',
    description:
      'Change an element in the previewed page, live. Set CSS properties, replace text or ' +
      'markup, set attributes, add or remove classes, or delete it outright. The change lands ' +
      'in the page the user is looking at immediately, so a screenshot afterwards shows it. ' +
      'It is a live experiment, not a code change: reloading the page undoes it.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to change.' },
        style: {
          type: 'object',
          description: 'CSS properties to set, e.g. {"background-color": "red", "font-size": "20px"}.',
          additionalProperties: { type: 'string' },
        },
        text: { type: 'string', description: 'Replace the element\'s text content.' },
        html: { type: 'string', description: 'Replace the element\'s inner markup.' },
        attrs: {
          type: 'object',
          description: 'Attributes to set. A null value removes the attribute.',
          additionalProperties: true,
        },
        addClass: { type: 'string', description: 'Class names to add, space separated.' },
        removeClass: { type: 'string', description: 'Class names to remove, space separated.' },
        remove: { type: 'boolean', description: 'Delete the element from the page.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/edit', args);
      const undo = r.before && r.before.style && Object.keys(r.before.style).length
        ? '\nPrevious values: ' + JSON.stringify(r.before.style)
        : '';
      return {
        text:
          (r.gone ? 'Removed ' : 'Changed ') + (r.name || args.selector) +
          (r.changed && r.changed.length ? '\nChanged: ' + r.changed.join(', ') : '') +
          (r.rect ? '\nNow ' + Math.round(r.rect.width) + ' × ' + Math.round(r.rect.height) : '') +
          undo +
          (r.persisted
            ? '\n\nThis survives a reload — ' + r.edits + ' edit(s) are being replayed on every load. ' +
              'custom_ai_view_revert puts the page back.'
            : ''),
      };
    },
  },
  {
    name: 'custom_ai_view_collect',
    description:
      'Save everything about what is on screen right now into one dated folder for this ' +
      'site: a screenshot, the page markup, the console output, and the selected element ' +
      'with its styles, plus a note tying them together. Use this when the user says ' +
      '"save this" or when you want a record of a problem before changing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'A line about why this was saved.' },
        fullPage: { type: 'boolean', description: 'Also capture the whole scrollable page.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/collect', args, 180000);
      return { text: 'Saved to ' + r.dir + '\n' + (r.files || []).map(f => '  ' + f).join('\n') };
    },
  },
  {
    name: 'custom_ai_view_record',
    description:
      'Screen-record the device. "start" begins and runs for as long as you like — frames ' +
      'go to disk, so length is limited only by space; "stop" ends it and writes an ' +
      'animated GIF into the site folder; "status" reports how long it has been running.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'] },
        fps: { type: 'number', description: 'Frames per second, 2 to 20. Default 10.' },
        name: { type: 'string', description: 'Name for the file.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      if (args.action === 'start') {
        const r = await call('/record/start', args, 120000);
        return { text: 'Recording at ' + r.fps + ' fps. Call this again with action "stop" to finish.' };
      }
      if (args.action === 'stop') {
        const r = await call('/record/stop', {}, 600000);
        return {
          text: 'Recorded ' + r.seconds + 's — ' + r.frames + ' frames at ' + r.fps + ' fps.\nSaved to ' + r.file,
        };
      }
      const r = await call('/record/status', {});
      return {
        text: r.recording
          ? 'Recording: ' + r.seconds + 's, ' + r.frames + ' frames, ' + r.megabytes + ' MB so far.'
          : 'Not recording.',
      };
    },
  },
  {
    name: 'custom_ai_view_library',
    description:
      'Where captures are filed, and which sites already have material. Pass a path to ' +
      'move the whole library somewhere else.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'New root folder for all captures.' },
      },
      additionalProperties: false,
    },
    run: async args => {
      if (args.path) {
        const r = await call('/library/root', args);
        return { text: 'Captures now go to ' + r.root };
      }
      const r = await call('/library', {});
      return {
        text: 'Root: ' + r.root +
          (r.sites && r.sites.length ? '\n\nSites with material:\n' + r.sites.map(s => '  ' + s).join('\n') : '\n\nNothing saved yet.'),
      };
    },
  },
  {
    name: 'custom_ai_view_edits',
    description: 'List the live edits currently being replayed into every page load.',
    inputSchema: { type: 'object', properties: { window: WINDOW_ARG }, additionalProperties: false },
    run: async args => {
      const r = await call('/edits', args);
      if (!r.edits || !r.edits.length) return { text: 'No live edits are active.' };
      return {
        text: r.edits
          .map((e, i) => (i + 1) + '. ' + e.selector + '\n   ' + JSON.stringify(
            Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'selector'))
          ))
          .join('\n'),
      };
    },
  },
  {
    name: 'custom_ai_view_revert',
    description:
      'Drop every live edit and reload, putting the page back exactly as the site serves it.',
    inputSchema: { type: 'object', properties: { window: WINDOW_ARG }, additionalProperties: false },
    run: async args => {
      const r = await call('/revert', args);
      return { text: r.cleared ? 'Reverted ' + r.cleared + ' edit(s) and reloaded.' : 'There was nothing to revert.' };
    },
  },
  {
    name: 'custom_ai_view_click',
    description: 'Tap an element in the previewed page, as a finger would.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string' }, window: WINDOW_ARG },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/click', args);
      /*
       * Say what was wrong with the tap, at the moment of the tap.
       *
       * Both of these were known and thrown away. A click on a button behind an
       * open modal reported success, and whatever came next waited for
       * something that was never going to happen. A 24×24 target reported
       * success too, and the fact that no finger could reliably hit it — the
       * whole point of a device frame — went unsaid.
       */
      const notes = [];
      if (r.covered) {
        notes.push('But ' + r.covered + ' is on top of it at that point — on a real screen the tap '
          + 'would have hit that instead. Check for an open dialog, a banner, or an overlay.');
      }
      if (r.small) {
        notes.push('Its target is ' + r.small + ' px, under the 44 pt a fingertip covers, so on the '
          + 'real device this tap is a matter of luck.');
      }
      return { text: 'Tapped ' + (r.name || args.selector) + '.' + (notes.length ? '\n' + notes.join('\n') : '') };
    },
  },
  {
    name: 'custom_ai_view_type',
    description:
      'Type into a field in the previewed page, firing the events a framework expects. ' +
      'Pass key: "Enter" to submit afterwards — many forms have no button to click instead.',
    inputSchema: {
      type: 'object',
      required: ['selector', 'text'],
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        key: {
          type: 'string',
          enum: ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
          description: 'Press this key after typing.',
        },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/type', args);
      return {
        text: 'Typed into ' + (r.name || args.selector) + '.' +
          (args.key ? ' Pressed ' + args.key + '.' : ''),
      };
    },
  },
  {
    name: 'custom_ai_view_back',
    description:
      'Go back one page, or forward. Prefer this to re-opening a URL after a wrong tap: ' +
      'reopening reloads a single-page app from nothing, losing the route, the scroll ' +
      'position and anything typed.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['back', 'forward'], description: 'Default back.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const where = args.direction === 'forward' ? '/forward' : '/back';
      await call(where, args);
      return { text: 'Went ' + (args.direction === 'forward' ? 'forward' : 'back') + '.' };
    },
  },
  /*
   * Windows.
   *
   * Every tool here takes a `window`, which was worth nothing while there was no
   * way to make a second one or to learn the id of the first. An agent asked to
   * "check this on the phone and the tablet" could only switch the one window
   * back and forth, losing the page each time and never seeing them together.
   */
  {
    name: 'custom_ai_view_windows',
    description:
      'List the open device windows: id, device, orientation, page title and address. '
      + 'Every other tool takes a `window` id, and this is where the ids come from — '
      + 'call it before driving two devices, or to find out what the person already has open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await call('/windows', {});
      const list = r.windows || [];
      if (!list.length) return { text: 'No windows are open.' };
      return {
        text: list.length + ' window' + (list.length === 1 ? '' : 's') + ':\n'
          + list.map(w => '  ' + w.id + '  ' + w.device + ' ' + w.orientation
            + '\n      ' + (w.title ? w.title + ' — ' : '') + (w.url || '(start page)')).join('\n'),
      };
    },
  },
  {
    name: 'custom_ai_view_new_window',
    description:
      'Open another device window, so two devices can be compared side by side without '
      + 'either losing its page. Returns the id to pass as `window` to the other tools. '
      + 'Prefer this to switching one window back and forth: changing the device on a window '
      + 'reloads it, and a single-page app comes back at its start rather than where you were.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Open this address. Omit for the start page.' },
        device: { type: 'string', description: 'Device id, e.g. iphone-16-pro. Omit for the default.' },
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/new-window', args);
      return { text: 'Opened ' + (r.device || 'a window') + ' as window ' + r.window + '.' };
    },
  },
  {
    name: 'custom_ai_view_close_window',
    description:
      'Close one device window. Use it to tidy up after a comparison — windows opened by an '
      + 'agent otherwise stay on the person\'s desk. Closing the last one leaves the app running.',
    inputSchema: {
      type: 'object',
      required: ['window'],
      properties: { window: { type: 'string', description: 'The id from custom_ai_view_windows.' } },
      additionalProperties: false,
    },
    run: async args => {
      await call('/close-window', args);
      return { text: 'Closed window ' + args.window + '.' };
    },
  },
  {
    name: 'custom_ai_view_hover',
    description:
      'Move the pointer onto an element without clicking. A menu that opens on hover, '
      + 'a tooltip, a row that only reveals its actions when pointed at — none of these can '
      + 'be reached by clicking, because a click lands on the parent and the thing you wanted '
      + 'never appears.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string' }, window: WINDOW_ARG },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/hover', args);
      return { text: 'Hovering ' + (r.name || args.selector) + '.' };
    },
  },
  {
    name: 'custom_ai_view_drag',
    description:
      'Press on an element, move by an offset, and release — which on a phone is a swipe. '
      + 'Carousels, sliders, pull-up sheets and swipe-to-delete rows all need this; none of '
      + 'them answer to a click. The path is walked in steps rather than jumped, because a '
      + 'single leap reads as a flick to some libraries and as nothing at all to others.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: 'What to press on.' },
        dx: { type: 'number', description: 'Horizontal distance in CSS pixels. Negative goes left.' },
        dy: { type: 'number', description: 'Vertical distance. Negative goes up.' },
        steps: { type: 'number', description: 'Intermediate moves, 4 to 24. Default 10.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/drag', args);
      return { text: (r.name || 'Dragged.') };
    },
  },
  {
    name: 'custom_ai_view_upload',
    description:
      'Give a file to a file input on the page. Every upload flow — an avatar, a document, '
      + 'an import — is otherwise unreachable: the native picker cannot be driven from script, '
      + 'and clicking the input only opens it. Pass a path on this machine; the file is read '
      + 'here and handed to the page as though a person had chosen it. Up to 4 MB each.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: 'The file input, e.g. "input[type=file]".' },
        file: { type: 'string', description: 'An absolute path on this machine.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Several paths, for a multiple input.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/upload', args);
      return { text: 'Uploaded ' + (r.name || 'the file') + '.' };
    },
  },
  {
    name: 'custom_ai_view_evaluate',
    description:
      'Run a JavaScript expression inside the previewed page and get its value back. '
      + 'This is the way to ask about state rather than about pixels: whether a store says '
      + 'the user is signed in, what a media query resolved to, an element\'s scrollHeight, '
      + 'whether a fetch settled. Every other tool here describes how the page looks; only '
      + 'this one can see what it thinks. An expression may await — promises are resolved. '
      + 'Note that changes made this way bypass the edit ledger, so custom_ai_view_revert '
      + 'will not undo them; prefer custom_ai_view_edit when the point is to change something.',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          description:
            'A JavaScript expression, e.g. "location.pathname" or '
            + '"matchMedia(\'(prefers-color-scheme: dark)\').matches". A body with an explicit '
            + 'return is also accepted for anything longer than one expression.',
        },
        selector: {
          type: 'string',
          description: 'Bind this element to `el` inside the expression, e.g. "el.scrollHeight".',
        },
        timeoutMs: { type: 'number', description: 'Default 10000, at most 30000.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/evaluate', args);
      const shown = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
      return { text: shown === undefined ? '(undefined)' : String(shown) };
    },
  },
  {
    name: 'custom_ai_view_key',
    description:
      'Press a key on the previewed page: Enter to submit a form, Escape to close a modal, ' +
      'Tab to move focus, arrows to move within a control. Without this, anything a page ' +
      'does on a keystroke rather than on a click cannot be reached at all.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          enum: ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
        },
        selector: { type: 'string', description: 'Aim at this element. Omit for whatever has focus.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/key', args);
      return { text: 'Pressed ' + (r.name || args.key) + '.' };
    },
  },
  {
    name: 'custom_ai_view_scroll',
    description:
      'Scroll the previewed page, or a scrollable element inside it. Positive dy scrolls down.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Element to scroll. Omit to scroll the page.' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      await call('/scroll', args);
      return { text: 'Scrolled by ' + (args.dx || 0) + ', ' + (args.dy || 0) + '.' };
    },
  },
  {
    // Named apart from custom_ai_view_record: two tools under one name meant the
    // second silently shadowed the first, and the route behind it was unreachable.
    name: 'custom_ai_view_record_clip',
    description:
      'Record the device frame for a fixed number of milliseconds and write an animated GIF. ' +
      'For an open-ended take, use custom_ai_view_record with start and stop instead. ' +
      'Returns the file path; recordings are too large to inline.',
    inputSchema: {
      type: 'object',
      properties: {
        durationMs: { type: 'number', description: 'How long to record, 500 to 30000. Default 5000.' },
        fps: { type: 'number', description: 'Frames per second, 2 to 20. Default 10.' },
        url: { type: 'string' },
        device: DEVICE_ARG,
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/record', args, 180000);
      // The rate it actually managed, when that differs from the rate asked
      // for. A clip stamped with a speed it was never captured at plays back a
      // different animation from the one that happened.
      const slow = r.realFps && r.realFps < r.fps * 0.8
        ? ' The machine managed ' + r.realFps + ' fps, not ' + r.fps + ', so the clip is that much '
          + 'coarser than asked for.'
        : '';
      return {
        text: 'Recorded ' + r.frames + ' frames at ' + r.fps + ' fps'
          + (r.elapsedMs ? ' in ' + (r.elapsedMs / 1000).toFixed(1) + 's' : '') + '.'
          + slow + '\nSaved to ' + r.file,
      };
    },
  },
  {
    name: 'custom_ai_view_console',
    description: 'Recent console output and uncaught errors from the previewed page.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many entries, default 50.' }, window: WINDOW_ARG },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/console', args);
      if (!r.entries || !r.entries.length) return { text: 'No console output captured.' };
      /*
       * How old each line is, because the buffer survives navigation and reloads.
       * Without it a forty-minute-old error from the previous build reads exactly
       * like one the change under test just caused.
       */
      const now = Date.now();
      const age = at => {
        if (!at) return '';
        const s = Math.round((now - at) / 1000);
        if (s < 5) return ' just now';
        if (s < 90) return ' ' + s + 's ago';
        if (s < 5400) return ' ' + Math.round(s / 60) + 'm ago';
        return ' ' + Math.round(s / 3600) + 'h ago';
      };
      return {
        text: r.entries
          .map(e => '[' + e.level + ']' + age(e.at) + ' ' + e.text + (e.source ? '  (' + e.source + ')' : ''))
          .join('\n'),
      };
    },
  },
  {
    name: 'custom_ai_view_set_device',
    description: 'Switch the device or orientation without changing the page.',
    inputSchema: {
      type: 'object',
      properties: {
        device: DEVICE_ARG,
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: args => call('/device', args).then(r => ({ text: 'Now showing ' + r.device + ' (' + r.width + '×' + r.height + ').' })),
  },
  {
    name: 'custom_ai_view_reload',
    description: 'Reload the page. Modes: normal, hard (bypass cache), purge (also wipe storage and cookies).',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['normal', 'hard', 'purge'] }, window: WINDOW_ARG },
      additionalProperties: false,
    },
    run: args => call('/reload', args).then(() => ({ text: 'Reloaded.' })),
  },
  {
    name: 'custom_ai_view_wait',
    description:
      'Wait until the page is ready before looking at it. Without this the only way to find out ' +
      'whether something has appeared is to take screenshots until it has — which costs an image ' +
      'per attempt and still reports whatever happened to be on screen at the time.\n' +
      'Give a selector to wait for an element, text to wait for words to appear, or neither to wait ' +
      'for loading to settle. Says what it waited for and how long it took; if it times out it says ' +
      'that plainly instead of pretending.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Wait until this CSS selector matches something visible.' },
        text: { type: 'string', description: 'Wait until this text is visible on the page.' },
        gone: {
          type: 'boolean',
          description: 'Invert it: wait until the selector or text is NO LONGER there — for a spinner ' +
            'to finish or a modal to close.',
        },
        timeoutMs: { type: 'number', description: 'Give up after this long. Default 10000, max 60000.' },
        window: WINDOW_ARG,
      },
      additionalProperties: false,
    },
    run: async args => {
      const r = await call('/wait', args, Math.min(70000, (args.timeoutMs || 10000) + 10000));
      if (r.found) {
        return { text: 'Ready after ' + r.waitedMs + 'ms — ' + r.what + '.' };
      }
      return {
        text: 'Gave up after ' + r.waitedMs + 'ms: ' + r.what + ' never happened. ' +
          'The page may still be loading, the selector may be wrong, or the thing may be off screen.',
      };
    },
  },
];

/*
 * Two tools under one name is not a clash the protocol reports — the second simply
 * shadows the first, and the route behind it becomes unreachable with nothing said.
 * That happened once already, so it is checked at startup where it cannot be missed.
 */
const duplicateNames = TOOLS.map(t => t.name).filter((n, i, all) => all.indexOf(n) !== i);
if (duplicateNames.length) {
  throw new Error('two tools share a name: ' + [...new Set(duplicateNames)].join(', '));
}

// -------------------------------------------------------------- jsonrpc io

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleLine(line);
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'custom-ai-view', version: VERSION },
      });
    }

    if (method === 'notifications/initialized' || method === 'initialized') return;

    if (method === 'ping') return respond(id, {});

    if (method === 'tools/list') {
      return respond(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return fail(id, -32602, 'Unknown tool: ' + params.name);
      try {
        const out = await tool.run(params.arguments || {});
        const content = [];
        if (out.text) content.push({ type: 'text', text: out.text });
        if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType });
        return respond(id, { content: content.length ? content : [{ type: 'text', text: 'Done.' }] });
      } catch (err) {
        return respond(id, {
          content: [{ type: 'text', text: String(err && err.message ? err.message : err) }],
          isError: true,
        });
      }
    }

    if (id !== undefined) fail(id, -32601, 'Method not found: ' + method);
  } catch (err) {
    if (id !== undefined) fail(id, -32603, String(err && err.message ? err.message : err));
  }
}

process.on('uncaughtException', err => {
  process.stderr.write('custom-ai-view mcp: ' + (err && err.stack ? err.stack : err) + '\n');
});
