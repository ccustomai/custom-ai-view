/* Start page logic. Talks to the panel with postMessage — it is a separate origin. */
(function () {
  'use strict';

  var GUESS = {
    3000: 'Next.js · CRA · Express',
    3001: 'Second dev server',
    4200: 'Angular',
    4321: 'Astro',
    5000: 'Flask · .NET',
    5173: 'Vite',
    5174: 'Vite',
    8000: 'Django · http.server',
    8080: 'Webpack · Tomcat',
    8100: 'Ionic',
    1313: 'Hugo',
    1234: 'Parcel',
  };

  var chev =
    '<svg class="chev" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';

  function send(url) {
    parent.postMessage({ type: 'dp:start:navigate', url: url }, '*');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.getElementById('urlForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = document.getElementById('url').value.trim();
    if (value) send(value);
  });

  function renderServers(ports) {
    var card = document.getElementById('serversCard');
    var box = document.getElementById('servers');
    if (!ports || !ports.length) {
      card.hidden = true;
      return;
    }
    box.innerHTML = ports
      .map(function (entry) {
        // The scanner reports how each port speaks, what the page calls itself and
        // where its icon is; older messages sent a bare number, and http was assumed.
        var port = typeof entry === 'object' ? entry.port : entry;
        var scheme = (typeof entry === 'object' && entry.scheme) || 'http';
        var title = (typeof entry === 'object' && entry.title) || '';
        var icon = (typeof entry === 'object' && entry.icon) || '';
        var url = scheme + '://localhost:' + port;

        /*
         * The name first, the address underneath.
         *
         * You pick a server by what it is, not by which number it happened to take —
         * and with three of them all called "Custom AI" on different ports, the name
         * is the part worth reading first. The port stays, quieter, for when two of
         * them share a name.
         */
        var name = title || GUESS[port] || 'A server';
        var below = 'localhost:' + port + (scheme === 'https' ? ' · https' : '');
        var mark = icon
          // Its own icon if it has one; the plain dot is what happens when it does not.
          ? '<img class="favicon" src="' + escapeHtml(icon) + '" alt="" ' +
            'onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),' +
            '{className:\'dotmark\'}))">'
          : '<span class="dotmark"></span>';

        return (
          '<button class="row" data-url="' + escapeHtml(url) + '">' +
          mark + '<span class="txt"><b>' + escapeHtml(name) + '</b>' +
          '<span>' + escapeHtml(below) + '</span></span>' + chev + '</button>'
        );
      })
      .join('');
    card.hidden = false;
  }

  function renderRecent(list) {
    var card = document.getElementById('recentCard');
    var box = document.getElementById('recent');
    var items = (list || []).filter(function (u) {
      return u && u.indexOf('vscode-') !== 0;
    });
    if (!items.length) {
      card.hidden = true;
      return;
    }
    box.innerHTML = items
      .slice(0, 6)
      .map(function (url) {
        var host = url;
        try {
          host = new URL(url).host;
        } catch (e) {}
        return (
          '<button class="row" data-url="' + escapeHtml(url) + '">' +
          '<span class="txt"><b>' + escapeHtml(host) + '</b><span>' + escapeHtml(url) + '</span></span>' +
          chev + '</button>'
        );
      })
      .join('');
    card.hidden = false;
  }

  document.addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row[data-url]') : null;
    if (row) send(row.dataset.url);
  });

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'dp:start:data') return;
    renderServers(msg.ports);
    renderRecent(msg.history);
    if (msg.device) {
      document.getElementById('deviceLine').textContent = 'Showing on ' + msg.device + '.';
    }
  });

  function reportBackground() {
    try {
      parent.postMessage(
        { type: 'dp:background', background: getComputedStyle(document.body).backgroundColor },
        '*'
      );
    } catch (e) {}
  }

  reportBackground();
  if (window.matchMedia) {
    var dark = window.matchMedia('(prefers-color-scheme: dark)');
    if (dark.addEventListener) dark.addEventListener('change', reportBackground);
  }

  parent.postMessage({ type: 'dp:start:ready' }, '*');
})();
