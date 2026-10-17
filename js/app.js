// App bootstrap: load the outline, wire up the editor, menu and sync.

import { Outline, ROOT, parseDoc } from './model.js';
import { UI } from './ui.js';
import { Sync } from './sync.js';
import * as dropbox from './dropbox.js';
import { load, save, requestPersistence } from './store.js';

const $ = (s) => document.querySelector(s);

const prefs = { showDone: true, ...load('prefs', {}) };

let nodes = load('doc');
let outline;
if (nodes && nodes[ROOT]) {
  outline = new Outline(nodes);
} else {
  outline = Outline.empty();
  save('pristine', true);
}

// ---------- persistence ----------
let saveTimer = null;
function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!save('doc', outline.nodes)) setStatus('error', 'Could not save locally');
}
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}

const ui = new UI(outline, {
  prefs,
  onChange() {
    save('pristine', null);
    persistSoon();
    sync.schedule();
  },
});

const sync = new Sync({
  getNodes: () => outline.nodes,
  replaceNodes(n) {
    outline.nodes = n;
    new Outline(outline.nodes); // ensures a root node exists
    outline.invalidate();
    persistNow();
    ui.refresh();
  },
  onStatus: setStatus,
});

// ---------- sync status ----------
const STATUS = {
  off: ['', 'Not syncing — connect Dropbox in the menu'],
  syncing: ['↻', 'Syncing…'],
  ok: ['✓', 'Synced'],
  offline: ['⚠', 'Offline — changes are saved on this device'],
  auth: ['⚠', 'Dropbox disconnected — reconnect in the menu'],
  error: ['⚠', 'Sync error'],
};
function setStatus(state, detail = '') {
  const el = $('#sync');
  const [icon, label] = STATUS[state];
  el.textContent = icon;
  el.dataset.state = state;
  el.title = detail ? `${label}: ${detail}` : label;
  renderMenu();
}

// ---------- menu ----------
const menu = $('#menu');
function renderMenu() {
  const connected = dropbox.isConnected();
  const last = load('lastSync');
  $('#m-connect').hidden = connected;
  $('#m-disconnect').hidden = !connected;
  $('#m-sync').hidden = !connected;
  $('#m-done').textContent = prefs.showDone ? 'Hide completed' : 'Show completed';
  $('#m-status').textContent = !dropbox.isConfigured()
    ? 'Dropbox app key not set (see README)'
    : connected
      ? `${$('#sync').title}${last ? ` · last ${new Date(last).toLocaleTimeString()}` : ''}`
      : 'Not connected';
}

$('#menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  renderMenu();
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});
menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  menu.hidden = true;
  switch (b.id) {
    case 'm-connect':
      if (!dropbox.isConfigured()) return alert('Set DROPBOX_APP_KEY in js/config.js first (see README).');
      persistNow();
      return dropbox.connect();
    case 'm-disconnect':
      if (!confirm('Stop syncing with Dropbox on this device? Your outline stays here and in Dropbox.')) return;
      dropbox.disconnect();
      return sync.forget();
    case 'm-sync':
      return sync.run();
    case 'm-done':
      prefs.showDone = !prefs.showDone;
      save('prefs', prefs);
      return ui.render();
    case 'm-export':
      return download(`outline-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(outline.toJSON(), null, 1), 'application/json');
    case 'm-export-txt':
      return download(`outline-${new Date().toISOString().slice(0, 10)}.txt`, toText(ui.zoom), 'text/plain');
    case 'm-import':
      return $('#import-file').click();
    case 'm-help':
      return $('#help').showModal();
  }
});

$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const imported = parseDoc(await f.text());
    if (!confirm(`Replace the whole outline with ${f.name}? (Undo is available.)`)) return;
    ui.checkpoint();
    outline.restore(imported);
    new Outline(outline.nodes);
    ui.zoomTo(ROOT);
    ui.onChange();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

$('#help-close').addEventListener('click', () => $('#help').close());

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toText(pid, depth = 0) {
  let s = '';
  for (const n of outline.children(pid)) {
    s += '  '.repeat(depth) + (n.d ? '- [x] ' : '- ') + n.t + '\n' + toText(n.id, depth + 1);
  }
  return s;
}

// ---------- sync triggers ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistNow();
    if (sync.dirty) sync.run();
  } else {
    sync.run();
  }
});
window.addEventListener('pagehide', persistNow);
window.addEventListener('online', () => sync.run());
setInterval(() => {
  if (document.visibilityState === 'visible') sync.run();
}, 60_000);

// ---------- start ----------
(async () => {
  try {
    if (await dropbox.handleRedirect()) sync.forget();
  } catch (e) {
    alert(`Dropbox sign-in failed: ${e.message}`);
  }
  setStatus(dropbox.isConnected() ? 'ok' : 'off');
  sync.run();
  requestPersistence();
  if (!location.hash && outline.size() <= 1) {
    const first = outline.children(ROOT)[0];
    if (first) ui.focus(first.id);
  }
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
