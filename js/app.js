// App bootstrap: load the outline, wire up the editor, menu and sync.

import { Outline, ROOT, parseDoc } from './model.js';
import { UI } from './ui.js';
import { Sync } from './sync.js';
import * as dropbox from './dropbox.js';
import { load, save, requestPersistence } from './store.js';
import { exportOPML, parseOPML, insertItems } from './opml.js';

const $ = (s) => document.querySelector(s);

const prefs = { showDone: true, theme: 'dark', font: 'arial', size: 17, showMd: false, spacing: 'auto', ...load('prefs', {}) };
const SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24];

// ---------- appearance (theme + font) ----------
// Each font falls back to something similar on Android, which lacks most
// Windows fonts.
const FONTS = {
  arial: ['Arial', 'Arial, "Liberation Sans", Roboto, Helvetica, sans-serif'],
  system: ['System default', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
  segoe: ['Segoe UI', '"Segoe UI", Roboto, system-ui, sans-serif'],
  verdana: ['Verdana', 'Verdana, "DejaVu Sans", Roboto, sans-serif'],
  tahoma: ['Tahoma', 'Tahoma, "DejaVu Sans", Roboto, sans-serif'],
  georgia: ['Georgia (serif)', 'Georgia, "Noto Serif", "Droid Serif", serif'],
  times: ['Times New Roman (serif)', '"Times New Roman", "Noto Serif", "Droid Serif", serif'],
  mono: ['Monospace', 'Consolas, "Cascadia Mono", "Roboto Mono", "Droid Sans Mono", monospace'],
};

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--font', (FONTS[prefs.font] || FONTS.arial)[1]);
  root.style.setProperty('--fs', `${prefs.size}px`);
  if (prefs.spacing && prefs.spacing !== 'auto') root.dataset.spacing = prefs.spacing;
  else delete root.dataset.spacing;
  document.body.classList.toggle('show-md', !!prefs.showMd);
  // Match the browser/OS chrome (Android status bar, installed-app title bar).
  requestAnimationFrame(() => {
    $('#theme-color').content = getComputedStyle(document.body).backgroundColor;
  });
}
applyAppearance();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);

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
      return syncNow();
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
    case 'm-export-opml': {
      const doc = outline.docOf(ui.zoom);
      const name = (doc.t || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      return download(`${name}.opml`, exportOPML(outline, doc.id), 'text/x-opml');
    }
    case 'm-import-opml':
      return $('#import-opml').click();
    case 'm-help':
      return $('#help').showModal();
    case 'm-settings':
      return openSettings();
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
    ui.zoom = null;
    ui.render();
    ui.onChange();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

$('#import-opml').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { title, items } = parseOPML(await f.text());
    ui.checkpoint();
    const cur = outline.docOf(ui.zoom);
    const name = title || f.name.replace(/\.(opml|xml)$/i, '');
    const doc = cur ? outline.insert(cur.p, cur.id, { t: name }) : outline.insert(ROOT, null, { t: name });
    const count = insertItems(outline, doc.id, items);
    ui.onChange();
    ui.openDoc(doc.id);
    ui.toast(`Imported ${count} item${count === 1 ? '' : 's'} into “${name}”`);
  } catch (err) {
    alert(`OPML import failed: ${err.message}`);
  }
});

$('#help-close').addEventListener('click', () => $('#help').close());

// Any dialog closes when you click (or tap) outside it, on the dimmed backdrop.
// Backdrop clicks are reported on the dialog itself, so check the position.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}

$('#set-font').innerHTML = Object.entries(FONTS)
  .map(([k, [label, stack]]) => `<option value="${k}" style='font-family:${stack}'>${label}</option>`)
  .join('');
$('#set-size').innerHTML = SIZES.map((s) => `<option value="${s}">${s}${s === 17 ? ' (default)' : ''}</option>`).join('');
for (const [id, key] of [['#set-theme', 'theme'], ['#set-font', 'font'], ['#set-size', 'size'], ['#set-spacing', 'spacing']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = key === 'size' ? Number(e.target.value) : e.target.value;
    save('prefs', prefs);
    applyAppearance();
  });
}
$('#set-md').addEventListener('change', (e) => setShowMd(e.target.checked));
$('#settings-close').addEventListener('click', () => $('#settings').close());

function setShowMd(on) {
  prefs.showMd = on;
  save('prefs', prefs);
  applyAppearance();
  $('#set-md').checked = on;
}

function openSettings() {
  $('#set-theme').value = prefs.theme;
  $('#set-font').value = prefs.font;
  $('#set-size').value = String(prefs.size);
  $('#set-spacing').value = prefs.spacing || 'auto';
  $('#set-md').checked = !!prefs.showMd;
  if (!$('#settings').open) $('#settings').showModal();
}

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
    s += '  '.repeat(depth) + (n.d ? '- [x] ' : '- ') + n.t + '\n';
    if (n.tb) {
      // Tables as "| a | b |" lines.
      for (const row of outline.children(n.id)) {
        s += '  '.repeat(depth + 1) + '| ' + outline.children(row.id).map((c) => c.t).join(' | ') + ' |\n';
      }
    } else {
      s += toText(n.id, depth + 1);
    }
  }
  return s;
}

// ---------- sync triggers ----------
function syncNow() {
  persistNow();
  if (!dropbox.isConnected()) return setStatus('off');
  sync.run();
}

// Ctrl+S (Cmd+S on Mac): sync now instead of the browser's "save page".
// Ctrl+, : settings.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    syncNow();
  } else if (e.code === 'Comma') {
    e.preventDefault();
    openSettings();
  } else if (e.code === 'KeyM') {
    e.preventDefault();
    setShowMd(!prefs.showMd);
    ui.toast(prefs.showMd ? 'Formatting characters shown while editing' : 'Formatting characters hidden');
  }
});
$('#sync').addEventListener('click', syncNow);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistNow();
    sync.stopWatching();
    if (sync.dirty) sync.run();
  } else {
    sync.run();
    sync.startWatching();
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
  if (document.visibilityState === 'visible') sync.startWatching();
  requestPersistence();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
