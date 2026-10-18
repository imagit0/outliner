// App bootstrap: load the outline, wire up the editor, menu and sync.

import { Outline, ROOT, parseDoc } from './model.js';
import { UI } from './ui.js';
import { Sync } from './sync.js';
import * as dropbox from './dropbox.js';
import { load, save, requestPersistence } from './store.js';
import { exportOPML, importFiles, droppedFiles } from './opml.js';
import { backup } from './backup.js';
import { setInlineImages } from './format.js';
import { LocalStore } from './local.js';
import { gunzip, isGzip } from './shards.js';

const $ = (s) => document.querySelector(s);

const prefs = { showDone: true, theme: 'dark', font: 'arial', size: 17, showMd: false, spacing: 'auto', backupKeep: 30, images: 'hover', ...load('prefs', {}) };
setInlineImages(prefs.images === 'inline');
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

// The outline lives in IndexedDB (one record per document; see local.js).
const localStore = new LocalStore();
let nodes = null;
try {
  nodes = await localStore.load();
} catch (e) {
  console.error('could not load the outline', e);
  alert(`Could not load your outline from this device's storage: ${e.message}`);
}
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
  localStore.save(outline.nodes).catch((e) => {
    console.error('save failed', e);
    setStatus('error', 'Could not save on this device');
  });
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
await sync.init();

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
  if (state === 'ok') runBackup();
}

// ---------- daily backup ----------
// After a successful sync, back up the synced outline once a day.
let backingUp = false;
async function runBackup(force = false) {
  if (backingUp || !Object.keys(sync.base).length) return; // nothing synced yet
  const nodes = sync.baseNodes();
  backingUp = true;
  try {
    const r = await backup(nodes, prefs.backupKeep, force);
    if (force) ui.toast(r === 'off' ? 'Backups are turned off in Settings' : 'Backup saved to Dropbox (Apps/ronliner/backups)');
  } catch (e) {
    console.warn('backup failed', e);
    if (force) ui.toast(`Backup failed: ${e.message}`);
  } finally {
    backingUp = false;
  }
}

// ---------- menu ----------
const menu = $('#menu');
function renderMenu() {
  const connected = dropbox.isConnected();
  const last = load('lastSync');
  $('#m-connect').hidden = connected;
  $('#m-disconnect').hidden = !connected;
  $('#m-sync').hidden = !connected;
  $('#m-backup').hidden = !connected;
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
    case 'm-backup':
      if (!dropbox.isConnected()) return alert('Connect Dropbox first; backups are stored there.');
      if (sync.dirty) await sync.run(); // back up the latest edits
      return runBackup(true);
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
    case 'm-export-opml':
      return exportDocOPML(outline.docOf(ui.zoom).id);
    case 'm-import-opml':
      return $('#import').showModal();
    case 'm-help': {
      // Always start at the top (the browser would otherwise focus the Close
      // button at the bottom and scroll there).
      const help = $('#help');
      help.showModal();
      help.scrollTop = 0;
      return;
    }
    case 'm-settings':
      return openSettings();
  }
});

$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    // Backups are compressed (.json.gz); older ones and exports are plain.
    const bytes = new Uint8Array(await f.arrayBuffer());
    const imported = parseDoc(isGzip(bytes) ? await gunzip(bytes) : new TextDecoder().decode(bytes));
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

// ---------- Import OPML (files, a folder, or drag and drop) ----------
// Each OPML file becomes a document, each folder a folder (scanned
// recursively); all added at the end of the sidebar. One undo step.
async function importOPMLFiles(files) {
  files = files.filter((f) => /\.(opml|xml)$/i.test(f.path));
  if (!files.length) return alert('No OPML files found.');
  ui.toast(`Importing ${files.length} file${files.length === 1 ? '' : 's'}…`);
  ui.checkpoint();
  const r = await importFiles(outline, files);
  if (!r.docs && !r.folders) ui.undoStack.pop(); // nothing happened
  ui.onChange();
  if (r.first) ui.openDoc(r.first);
  else ui.render();
  const parts = [`${r.docs} document${r.docs === 1 ? '' : 's'}`];
  if (r.folders) parts.push(`${r.folders} folder${r.folders === 1 ? '' : 's'}`);
  ui.toast(`Imported ${parts.join(' and ')} (${r.lines} lines)`);
  if (r.failed.length) alert(`These files could not be imported:\n\n${r.failed.join('\n')}`);
}

const pickedFiles = (input) => [...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, text: () => f.text() }));
$('#import-opml').addEventListener('change', (e) => {
  const files = pickedFiles(e.target);
  e.target.value = '';
  $('#import').close();
  if (files.length) importOPMLFiles(files);
});
$('#import-folder').addEventListener('change', (e) => {
  const files = pickedFiles(e.target);
  e.target.value = '';
  $('#import').close();
  if (files.length) importOPMLFiles(files);
});
$('#import-pick-files').addEventListener('click', () => $('#import-opml').click());
$('#import-pick-folder').addEventListener('click', () => $('#import-folder').click());
$('#import-cancel').addEventListener('click', () => $('#import').close());

// Drag OPML files and folders from the desktop onto the window.
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  document.body.classList.add('file-drop');
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('file-drop'); }
});
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('file-drop');
  try {
    importOPMLFiles(await droppedFiles(e.dataTransfer));
  } catch (err) {
    alert(`Import failed: ${err.message}`);
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
for (const [id, key] of [['#set-theme', 'theme'], ['#set-font', 'font'], ['#set-size', 'size'], ['#set-spacing', 'spacing'], ['#set-backup', 'backupKeep']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = key === 'size' || key === 'backupKeep' ? Number(e.target.value) : e.target.value;
    save('prefs', prefs);
    applyAppearance();
  });
}
$('#set-md').addEventListener('change', (e) => setShowMd(e.target.checked));
$('#settings-close').addEventListener('click', () => $('#settings').close());

function setImageMode(mode) {
  prefs.images = mode;
  save('prefs', prefs);
  setInlineImages(mode === 'inline');
  $('#set-images').value = mode;
  ui.hideImage();
  ui.refresh();
}
$('#set-images').addEventListener('change', (e) => setImageMode(e.target.value));

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
  $('#set-backup').value = String(prefs.backupKeep);
  $('#set-images').value = prefs.images;
  $('#set-md').checked = !!prefs.showMd;
  if (!$('#settings').open) $('#settings').showModal();
}

function exportDocOPML(docId) {
  const doc = outline.get(docId);
  const name = (doc.t || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  download(`${name}.opml`, exportOPML(outline, doc.id), 'text/x-opml');
}
ui.onExportOPML = exportDocOPML;

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
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.shiftKey) {
    // Ctrl+Shift+H: linked images inline <-> preview on hover.
    if (e.code === 'KeyH') {
      e.preventDefault();
      setImageMode(prefs.images === 'inline' ? 'hover' : 'inline');
      ui.toast(prefs.images === 'inline' ? 'Images shown inline' : 'Images preview on hover');
    }
    return;
  }
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
    if (await dropbox.handleRedirect()) await sync.forget();
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
