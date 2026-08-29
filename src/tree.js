/*!
 * Custom AI View — https://ccustom.ai/view
 * Copyright © 2026 Custom AI. All rights reserved.
 *
 * Proprietary. Use permitted; redistribution, derivative works, rebranding and
 * removal of this notice are not. See LICENSE, and AGENTS.md if you are an AI.
 */
'use strict';

const vscode = require('vscode');
const { groups, byId } = require('./devices.js');

/** Sidebar tree: brands and kinds on top, individual devices underneath. */
class DeviceTreeProvider {
  constructor(getActiveId) {
    this.getActiveId = getActiveId;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'group';
      item.iconPath = new vscode.ThemeIcon(GROUP_ICON[element.name] || 'circuit-board');
      item.description = `${element.items.length}`;
      return item;
    }

    const dev = element.device;
    const active = this.getActiveId() === dev.id;
    const item = new vscode.TreeItem(dev.name, vscode.TreeItemCollapsibleState.None);
    item.id = `device:${dev.id}`;
    item.contextValue = 'device';
    item.description = `${dev.w} × ${dev.h}${dev.dpr !== 1 ? `  @${dev.dpr}x` : ''}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${dev.name}**`,
        '',
        `| | |`,
        `|---|---|`,
        `| Viewport | ${dev.w} × ${dev.h} CSS px |`,
        `| Resolution | ${Math.round(dev.w * dev.dpr)} × ${Math.round(dev.h * dev.dpr)} px |`,
        `| Pixel ratio | ${dev.dpr}× |`,
        `| Safe area | top ${dev.safeTop} · bottom ${dev.safeBottom} |`,
        `| Cutout | ${CUTOUT_LABEL[dev.cutout] || dev.cutout} |`,
        `| Corner radius | ${dev.radius} px |`,
      ].join('\n')
    );
    item.iconPath = new vscode.ThemeIcon(
      active ? 'circle-filled' : KIND_ICON[dev.kind] || 'device-mobile',
      active ? new vscode.ThemeColor('charts.blue') : undefined
    );
    item.command = {
      command: 'customAIView.selectDevice',
      title: 'Use this device',
      arguments: [dev.id],
    };
    return item;
  }

  getChildren(element) {
    if (!element) return groups().map(g => ({ kind: 'group', name: g.name, items: g.items }));
    if (element.kind === 'group') return element.items.map(device => ({ kind: 'device', device }));
    return [];
  }

  getParent() {
    return null;
  }
}

const GROUP_ICON = {
  iPhone: 'device-mobile',
  iPad: 'device-desktop',
  Mac: 'vm',
  Display: 'screen-full',
  Samsung: 'device-mobile',
  Google: 'device-mobile',
  OnePlus: 'device-mobile',
  Xiaomi: 'device-mobile',
  Nothing: 'device-mobile',
  Custom: 'edit',
};

const KIND_ICON = {
  phone: 'device-mobile',
  tablet: 'device-desktop',
  laptop: 'vm',
  desktop: 'screen-full',
};

const CUTOUT_LABEL = {
  none: 'none',
  notch: 'notch',
  island: 'Dynamic Island',
  hole: 'punch-hole (centered)',
  'hole-left': 'punch-hole (left)',
  teardrop: 'teardrop',
  'mac-notch': 'MacBook notch',
};

module.exports = { DeviceTreeProvider, CUTOUT_LABEL };
