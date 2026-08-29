/*
 * Physical display metrics.
 *
 * To draw a phone at its true size on screen you need one number the browser will
 * never tell you: how many millimetres a pixel actually is. The OS knows — the
 * monitor reports its physical size over EDID — so ask the OS.
 *
 * What comes back is millimetres per *physical* pixel. The webview turns that into
 * millimetres per CSS pixel by multiplying by devicePixelRatio, which is where the
 * display-scaling setting lives.
 *
 * EDID rounds the panel size to whole centimetres, so this lands within about 1.5%.
 * That is close enough to hold a real phone against the screen and see it match; a
 * calibration card is offered for anyone who wants it exact.
 */
'use strict';

const { execFile } = require('child_process');

const PS_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$params = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams
$ids = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID
$modes = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 }
foreach ($p in $params) {
  $id = $ids | Where-Object { $_.InstanceName -eq $p.InstanceName } | Select-Object -First 1
  $name = ''
  if ($id -and $id.UserFriendlyName) {
    $name = ($id.UserFriendlyName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ }) -join ''
  }
  $mode = $modes | Select-Object -First 1
  $out += [pscustomobject]@{
    name = $name.Trim()
    widthMm = [int]$p.MaxHorizontalImageSize * 10
    heightMm = [int]$p.MaxVerticalImageSize * 10
    widthPx = if ($mode) { [int]$mode.CurrentHorizontalResolution } else { 0 }
    heightPx = if ($mode) { [int]$mode.CurrentVerticalResolution } else { 0 }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

function run(command, args, timeout = 8000) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const child = execFile(command, args, { windowsHide: true, timeout }, (err, stdout) => {
        finish(err ? null : String(stdout));
      });
      child.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

async function detectWindows() {
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_QUERY]);
  if (!stdout) return null;
  let list;
  try {
    list = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(list)) list = [list];

  const usable = list.filter(m => m && m.widthMm > 40 && m.heightMm > 30 && m.widthPx > 100);
  if (!usable.length) return null;

  return usable.map(m => ({
    name: m.name || 'Display',
    widthPx: m.widthPx,
    heightPx: m.heightPx,
    widthMm: m.widthMm,
    heightMm: m.heightMm,
    mmPerPx: m.widthMm / m.widthPx,
    dpi: Math.round((m.widthPx / m.widthMm) * 25.4),
    diagonalIn: Math.round((Math.hypot(m.widthMm, m.heightMm) / 25.4) * 10) / 10,
    source: 'edid',
  }));
}

async function detectMac() {
  const stdout = await run('system_profiler', ['SPDisplaysDataType', '-json'], 12000);
  if (!stdout) return null;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const displays = [];
  for (const gpu of data.SPDisplaysDataType || []) {
    for (const d of gpu.spdisplays_ndrvs || []) {
      // "1920 x 1080" or "3024 x 1964 Retina"
      const res = /(\d+)\s*x\s*(\d+)/.exec(d._spdisplays_resolution || d.spdisplays_resolution || '');
      const inches = parseFloat(d._spdisplays_display_size_inches || d.spdisplays_display_size || '');
      if (!res || !inches) continue;
      const widthPx = Number(res[1]);
      const heightPx = Number(res[2]);
      const diagMm = inches * 25.4;
      const ratio = widthPx / Math.hypot(widthPx, heightPx);
      const widthMm = diagMm * ratio;
      displays.push({
        name: d._name || 'Display',
        widthPx,
        heightPx,
        widthMm: Math.round(widthMm),
        heightMm: Math.round((widthMm * heightPx) / widthPx),
        mmPerPx: widthMm / widthPx,
        dpi: Math.round((widthPx / widthMm) * 25.4),
        diagonalIn: inches,
        source: 'system_profiler',
      });
    }
  }
  return displays.length ? displays : null;
}

async function detectLinux() {
  const stdout = await run('xrandr', ['--query']);
  if (!stdout) return null;
  const displays = [];
  // e.g. "eDP-1 connected primary 1920x1080+0+0 (normal ...) 344mm x 193mm"
  const re = /^(\S+) connected[^\n]*?(\d+)x(\d+)\+\d+\+\d+[^\n]*?(\d+)mm x (\d+)mm/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    const widthPx = Number(m[2]);
    const widthMm = Number(m[4]);
    if (!widthPx || !widthMm) continue;
    displays.push({
      name: m[1],
      widthPx,
      heightPx: Number(m[3]),
      widthMm,
      heightMm: Number(m[5]),
      mmPerPx: widthMm / widthPx,
      dpi: Math.round((widthPx / widthMm) * 25.4),
      diagonalIn: Math.round((Math.hypot(widthMm, Number(m[5])) / 25.4) * 10) / 10,
      source: 'xrandr',
    });
  }
  return displays.length ? displays : null;
}

let cached = null;

/**
 * @param {boolean} force skip the cache; the monitor can change
 * @returns {Promise<{displays: Array, primary: object|null}>}
 */
async function detect(force) {
  if (cached && !force) return cached;

  let displays = null;
  try {
    if (process.platform === 'win32') displays = await detectWindows();
    else if (process.platform === 'darwin') displays = await detectMac();
    else displays = await detectLinux();
  } catch {
    displays = null;
  }

  cached = {
    displays: displays || [],
    primary: displays && displays.length ? displays[0] : null,
  };
  return cached;
}

module.exports = { detect };
