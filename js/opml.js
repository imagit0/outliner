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

// Insert parsed items under parentId (in order). Returns the number of nodes.
export function insertItems(outline, parentId, items) {
  let count = 0;
  let after = null;
  for (const it of items) {
    const n = outline.insert(parentId, after, it.fields);
    after = n.id;
    count += 1 + insertItems(outline, n.id, it.children);
  }
  return count;
}
