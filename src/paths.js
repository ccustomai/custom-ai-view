/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
/*
 * Where the app's own files live.
 *
 * Running from source that is simply the repository. Running as a packaged
 * executable there is no repository — the media, the shim and the device catalogue
 * are carried inside the binary and unpacked to a cache directory on first launch,
 * so the root has to be told, not guessed from __dirname.
 */
'use strict';

const path = require('path');

let root = process.env.DP_RESOURCE_ROOT || path.join(__dirname, '..');

module.exports = {
  get root() {
    return root;
  },
  setRoot(dir) {
    root = dir;
  },
  resolve(...parts) {
    return path.join(root, ...parts);
  },
};
