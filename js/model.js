// Outline data model.
//
// The outline is stored as a flat map of nodes keyed by id. Each node knows its
// parent (p) and a fractional position key (k) that orders it among siblings.
// Keeping it flat (instead of nested arrays) lets sync merge per node and per
// field: a move is just a change of (p, k), an edit is a change of t.
//
// Node fields:
//   id  string
//   p   parent id (null only for the root)
//   k   position key, compared as a plain string
//   t   text
//   d   done (bool)
//   c   collapsed (bool)
//   cl  color label 1-6 (0 or missing = none)
//   f   folder (bool; missing = false)
//   m   last-modified time in ms (used to break merge ties)
//
// The sidebar tree is made of folders and documents: a folder (f) lives under
// the root or another folder; any other node whose parent is the root or a
// folder is a document. Everything below a document is outline items.

export const ROOT = 'root';
export const FORMAT = 'outliner/1';

// ---------- fractional position keys ----------
// Base-62 digits in ASCII order so plain string comparison matches numeric order.
// A key is the fraction 0.<digits>; keys never end in '0', so there is always
// room before any key.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a, b) {
  // a < b; a may be '' (zero), b may be null (one).
  if (b !== null) {
    let n = 0;
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// Key strictly between a and b (either may be null for open-ended).
export function keyBetween(a, b) {
  a = a || '';
  if (b !== null && b !== undefined && !(a < b)) throw new Error(`keyBetween: ${a} !< ${b}`);
  return midpoint(a, b === undefined ? null : b);
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const x of bytes) s += DIGITS[x % 62];
  return s;
}

// ---------- outline ----------
export class Outline {
  constructor(nodes) {
    this.nodes = nodes || {};
    if (!this.nodes[ROOT]) this.nodes[ROOT] = { id: ROOT, p: null, k: '', t: '', d: false, c: false, m: 0 };
    this._kids = null;
  }

  static empty() {
    const o = new Outline();
    const doc = o.insert(ROOT, null, { t: 'My outline' });
    o.insert(doc.id, null, {});
    return o;
  }

  // Root or a folder: holds documents and folders rather than items.
  isContainer(id) {
    const n = this.nodes[id];
    return !!n && (n.id === ROOT || !!n.f);
  }

  isDoc(id) {
    const n = this.nodes[id];
    return !!n && !n.f && n.p !== null && this.isContainer(n.p);
  }

  // The document that contains id (or id itself if it is one).
  docOf(id) {
    let n = this.nodes[id];
    while (n && n.p !== null && !this.isContainer(n.p)) n = this.nodes[n.p];
    return n && n.p !== null && !n.f ? n : null;
  }

  // All documents in sidebar order.
  allDocs(pid = ROOT, out = []) {
    for (const n of this.children(pid)) {
      if (n.f) this.allDocs(n.id, out);
      else out.push(n);
    }
    return out;
  }

  toJSON() { return { format: FORMAT, nodes: this.nodes }; }

  snapshot() { return structuredClone(this.nodes); }

  invalidate() { this._kids = null; }

  get(id) { return this.nodes[id]; }

  children(pid) {
    if (!this._kids) {
      const idx = new Map();
      for (const n of Object.values(this.nodes)) {
        if (n.p === null) continue;
        let arr = idx.get(n.p);
        if (!arr) idx.set(n.p, (arr = []));
        arr.push(n);
      }
      for (const arr of idx.values()) arr.sort(cmpNode);
      this._kids = idx;
    }
    return this._kids.get(pid) || [];
  }

  hasChildren(id) { return this.children(id).length > 0; }

  ancestors(id) {
    // From the root's child down to the node's parent.
    const out = [];
    let n = this.nodes[id];
    while (n && n.p !== null) {
      n = this.nodes[n.p];
      if (n) out.unshift(n);
    }
    return out;
  }

  isAncestor(anc, id) {
    let n = this.nodes[id];
    while (n && n.p !== null) {
      if (n.p === anc) return true;
      n = this.nodes[n.p];
    }
    return false;
  }

  prevSibling(id) {
    const n = this.nodes[id];
    const sibs = this.children(n.p);
    const i = sibs.indexOf(n);
    return i > 0 ? sibs[i - 1] : null;
  }

  nextSibling(id) {
    const n = this.nodes[id];
    const sibs = this.children(n.p);
    const i = sibs.indexOf(n);
    return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
  }

  // Position key for a node placed in pid right after `afterId` (null = first).
  _keyAfter(pid, afterId) {
    this._fixDuplicateKeys(pid);
    const sibs = this.children(pid);
    if (afterId === null) return keyBetween(null, sibs.length ? sibs[0].k : null);
    const i = sibs.findIndex((s) => s.id === afterId);
    if (i < 0) return keyBetween(sibs.length ? sibs[sibs.length - 1].k : null, null);
    return keyBetween(sibs[i].k, i + 1 < sibs.length ? sibs[i + 1].k : null);
  }

  // Concurrent inserts on two devices can produce equal keys; give later
  // duplicates fresh keys so there is always room between neighbours.
  _fixDuplicateKeys(pid) {
    const sibs = this.children(pid);
    let changed = false;
    for (let i = 1; i < sibs.length; i++) {
      if (sibs[i].k <= sibs[i - 1].k) {
        const next = sibs.slice(i + 1).find((s) => s.k > sibs[i - 1].k);
        sibs[i].k = keyBetween(sibs[i - 1].k, next ? next.k : null);
        sibs[i].m = Date.now();
        changed = true;
      }
    }
    if (changed) this.invalidate();
  }

  insert(pid, afterId, fields) {
    const node = { id: newId(), p: pid, k: this._keyAfter(pid, afterId), t: '', d: false, c: false, m: Date.now(), ...fields };
    this.nodes[node.id] = node;
    this.invalidate();
    return node;
  }

  move(id, pid, afterId) {
    if (id === ROOT || id === pid || this.isAncestor(id, pid)) return false;
    const n = this.nodes[id];
    // Compute the key with the node temporarily out of the sibling list.
    n.p = '\u0000moving';
    this.invalidate();
    n.k = this._keyAfter(pid, afterId);
    n.p = pid;
    n.m = Date.now();
    this.invalidate();
    return true;
  }

  update(id, fields) {
    const n = this.nodes[id];
    if (!n) return;
    Object.assign(n, fields, { m: Date.now() });
    if ('p' in fields || 'k' in fields) this.invalidate();
  }

  remove(id) {
    if (id === ROOT) return;
    for (const c of this.children(id)) this.remove(c.id);
    delete this.nodes[id];
    this.invalidate();
  }

  // Replace the whole node map, bumping m on nodes that differ so the change
  // counts as a fresh local edit for sync (used by undo/redo).
  restore(nodes) {
    const now = Date.now();
    for (const id of Object.keys(this.nodes)) if (!nodes[id]) delete this.nodes[id];
    for (const [id, n] of Object.entries(nodes)) {
      const cur = this.nodes[id];
      if (!cur || !sameNode(cur, n)) this.nodes[id] = { ...n, m: now };
    }
    this.invalidate();
  }

  // Count of nodes excluding root.
  size() { return Object.keys(this.nodes).length - 1; }
}

export function cmpNode(a, b) {
  return a.k < b.k ? -1 : a.k > b.k ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const FIELDS = ['p', 'k', 't', 'd', 'c', 'cl', 'f'];

// Missing optional fields (older nodes have no cl / f) count as their default.
const DEFAULTS = { cl: 0, f: false };
const norm = (f, v) => (v === undefined && f in DEFAULTS ? DEFAULTS[f] : v);

export function sameNode(a, b) {
  return FIELDS.every((f) => norm(f, a[f]) === norm(f, b[f]));
}

export function sameNodes(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((id) => b[id] && sameNode(a[id], b[id]));
}

export function parseDoc(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  if (!doc || doc.format !== FORMAT || typeof doc.nodes !== 'object') throw new Error('Not an outliner file');
  return doc.nodes;
}
