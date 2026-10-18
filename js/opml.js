// OPML export / import.
//
// Each item is an <outline text="…">. Extra attributes (OPML allows any):
//   complete="true"      done (same as Dynalist)
//   colorLabel="1".."6"  color (same as Dynalist)
//   heading="1".."3"     heading level
//   table="true"         this outline is a table; its child outlines are the
//                        rows and their children are the cells
//   tableHeader="true"   the table's first row is a header
//   tableBorders="false" the table is drawn without cell borders
//   colWidths="120,,80"  column widths in px (empty = automatic)
//   collapsed="true"     collapsed
// Other outliners simply show a table as caption → rows → cells. Dynalist's
// notes (_note) are imported as child lines.

import { keysBetween, newId, ROOT } from './model.js';

const attrEsc = (s) =>
  String(s).replace(/[&<>"\n\r\t]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' })[c]);

export function exportOPML(outline, rootId) {
  const root = outline.get(rootId);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${attrEsc(root.t || 'Untitled')}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
  ];
  const walk = (pid, depth) => {
    for (const n of outline.children(pid)) {
      let a = `text="${attrEsc(n.t)}"`;
      if (n.d) a += ' complete="true"';
      if (n.cl) a += ` colorLabel="${n.cl}"`;
      if (n.h) a += ` heading="${n.h}"`;
      if (n.c) a += ' collapsed="true"';
      if (n.tb) {
        a += ' table="true"';
        if (n.hd) a += ' tableHeader="true"';
        if (n.nb) a += ' tableBorders="false"';
        if (n.cw) a += ` colWidths="${attrEsc(n.cw)}"`;
      }
      const pad = '  '.repeat(depth);
      if (outline.hasChildren(n.id)) {
        lines.push(`${pad}<outline ${a}>`);
        walk(n.id, depth + 1);
        lines.push(`${pad}</outline>`);
      } else {
        lines.push(`${pad}<outline ${a}/>`);
      }
    }
  };
  walk(rootId, 2);
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

// Parse OPML text into { title, items } where items is a tree of
// { fields, children } ready to insert. Throws on invalid input.
export function parseOPML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid OPML/XML.');
  const body = doc.querySelector('opml > body') || doc.querySelector('body');
  if (!body) throw new Error('No <body> found in this OPML file.');
  const title = doc.querySelector('opml > head > title')?.textContent?.trim() || '';
  const num = (el, ...names) => {
    for (const n of names) {
      const v = parseInt(el.getAttribute(n), 10);
      if (v) return v;
    }
    return 0;
  };
  const flag = (el, ...names) => names.some((n) => /^(true|1|yes)$/i.test(el.getAttribute(n) || ''));
  const convert = (el) => {
    const cl = num(el, 'colorLabel', '_colorLabel', 'color');
    const h = num(el, 'heading', '_heading');
    const fields = { t: (el.getAttribute('text') ?? el.getAttribute('title') ?? '').replace(/\r?\n/g, ' ') };
    if (flag(el, 'complete', '_complete', 'checked')) fields.d = true;
    if (cl >= 1 && cl <= 6) fields.cl = cl;
    if (h >= 1 && h <= 3) fields.h = h;
    if (flag(el, 'collapsed', '_collapsed')) fields.c = true;
    const isTable = flag(el, 'table');
    if (isTable) {
      fields.tb = true;
      if (flag(el, 'tableHeader')) fields.hd = true;
      if (/^(false|0|no)$/i.test(el.getAttribute('tableBorders') || '')) fields.nb = true;
      if (el.getAttribute('colWidths')) fields.cw = el.getAttribute('colWidths');
    }
    const children = [...el.children].filter((c) => c.tagName === 'outline').map(convert);
    const note = el.getAttribute('_note');
    if (note && !isTable) {
      const noteLines = note.split(/\r?\n/).filter((l) => l.trim());
      children.unshift(...noteLines.map((t) => ({ fields: { t }, children: [] })));
    }
    return { fields, children };
  };
  const items = [...body.children].filter((c) => c.tagName === 'outline').map(convert);
  return { title, items };
}

// Import OPML files and folders. files: [{ path, text() }] where path is
// relative to what was picked: 'Notes.opml' for a picked file,
// 'Work/sub/Plan.opml' for a file inside a picked folder 'Work'.
// Each OPML file becomes a document (named by its title, else the file
// name); each folder becomes a folder if it contains OPML somewhere inside.
// Everything is added at the end of the sidebar; folders first, then
// documents, in natural name order; folders below the top level start
// collapsed. Returns { docs, folders, lines, failed, first } (first = the
// first document created).
export async function importFiles(outline, files) {
  const tree = { dirs: new Map(), files: [] };
  for (const f of files) {
    let dir = tree;
    for (const part of f.path.split('/').slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      dir = dir.dirs.get(part);
    }
    dir.files.push(f);
  }
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  const fileName = (f) => f.path.split('/').pop();
  const result = { docs: 0, folders: 0, lines: 0, failed: [], first: null };
  // Fill `parentId` (after `after`) with dir's folders and documents.
  const fill = async (dir, parentId, after, depth) => {
    let prev = after;
    for (const sub of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
      const folder = outline.insert(parentId, prev, { t: sub.name, f: true, c: depth > 0 });
      result.folders++;
      await fill(sub, folder.id, null, depth + 1);
      prev = folder.id;
    }
    for (const f of [...dir.files].sort((a, b) => byName(fileName(a), fileName(b)))) {
      try {
        const { title, items } = parseOPML(await f.text());
        const doc = outline.insert(parentId, prev, { t: title || fileName(f).replace(/\.(opml|xml)$/i, '') });
        prev = doc.id;
        result.lines += insertItems(outline, doc.id, items);
        result.docs++;
        result.first ||= doc.id;
      } catch (err) {
        result.failed.push(`${f.path}: ${err.message}`);
      }
    }
  };
  await fill(tree, ROOT, outline.children(ROOT).at(-1)?.id ?? null, 0);
  return result;
}

// Files dropped from the desktop (any mix of files and folders), as
// [{ path, text() }] for importFiles. Only .opml / .xml files are kept.
// Must be called during the drop event (the browser forgets the items after).
export function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const isOpml = (name) => /\.(opml|xml)$/i.test(name);
  if (!entries.length) {
    // No folder access (older browsers): just the dropped files themselves.
    return Promise.resolve([...dataTransfer.files].filter((f) => isOpml(f.name)).map((f) => ({ path: f.name, text: () => f.text() })));
  }
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      if (!isOpml(entry.name)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + entry.name, text: () => file.text() });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns the folder's contents in batches until empty.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  return Promise.all(entries.map((e) => walk(e, ''))).then(() => out);
}

// Insert parsed items (in order) as the first children of parentId. Returns
// the number of nodes. Builds the nodes directly with evenly spaced keys, so
// importing tens of thousands of lines is fast and keys stay short.
export function insertItems(outline, parentId, items) {
  const first = outline.children(parentId)[0];
  const now = Date.now();
  let count = 0;
  const add = (pid, list, before) => {
    const keys = keysBetween(null, before, list.length);
    list.forEach((it, i) => {
      const n = { id: newId(), p: pid, k: keys[i], t: '', d: false, c: false, m: now, ...it.fields };
      outline.nodes[n.id] = n;
      count++;
      add(n.id, it.children || [], null);
    });
  };
  add(parentId, items, first ? first.k : null);
  outline.invalidate();
  return count;
}
