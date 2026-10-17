// Three-way merge of outline node maps.
//
// base   = the version both sides last agreed on (last successful sync)
// local  = this device's current nodes
// remote = what is in the cloud now
//
// Per node and per field: a side that changed a field (vs base) wins; if both
// changed it, the newer node (m) wins. Position (p, k) is merged as one field
// since a move changes both. Text conflicts never lose data: the losing text
// is kept as a sibling marked "(conflict)".
// Deleting a node loses to an edit of it on the other side.

import { ROOT, FIELDS, newId, sameNode } from './model.js';

const changed = (n, b, fields) => !sameNode(pick(n, fields), pick(b, fields));
const pick = (n, fields) => Object.fromEntries(FIELDS.map((f) => [f, fields.includes(f) ? n[f] : null]));

export function merge(base, local, remote) {
  base = base || {};
  const out = {};
  const conflicts = [];
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const id of ids) {
    const b = base[id], l = local[id], r = remote[id];
    if (!b) {
      // Created on one side (or, impossibly, both): keep it.
      out[id] = { ...(l && r ? (r.m > l.m ? r : l) : l || r) };
      continue;
    }
    if (!l || !r) {
      // Deleted on one side. Keep it only if the other side edited it.
      const kept = l || r;
      if (kept && changed(kept, b, FIELDS)) out[id] = { ...kept };
      continue;
    }
    const n = { ...b, m: Math.max(l.m || 0, r.m || 0) };
    const localNewer = (l.m || 0) >= (r.m || 0);
    for (const group of [['p', 'k'], ['t'], ['d'], ['c'], ['cl'], ['f'], ['h'], ['tb'], ['cw'], ['hd'], ['nb']]) {
      const lc = changed(l, b, group), rc = changed(r, b, group);
      const src = lc && rc ? (localNewer ? l : r) : lc ? l : rc ? r : b;
      for (const f of group) n[f] = src[f];
    }
    if (l.t !== b.t && r.t !== b.t && l.t !== r.t) {
      conflicts.push({ node: n, loser: localNewer ? r.t : l.t });
    }
    out[id] = n;
  }

  if (!out[ROOT]) out[ROOT] = { ...(local[ROOT] || remote[ROOT] || base[ROOT] || { id: ROOT, p: null, k: '', t: '', d: false, c: false, m: 0 }) };

  // A node whose parent was deleted on the other side: bring the parent back
  // (from whichever version still has it) so the child keeps its context.
  for (const id of Object.keys(out)) {
    let n = out[id];
    while (n.p !== null && !out[n.p]) {
      const parent = local[n.p] || remote[n.p] || base[n.p];
      if (!parent) { n.p = ROOT; break; }
      out[parent.id] = { ...parent };
      n = out[parent.id];
    }
  }

  // Concurrent moves can create a cycle (A into B here, B into A there).
  for (const id of Object.keys(out)) {
    const seen = new Set();
    let n = out[id];
    while (n && n.p !== null) {
      if (seen.has(n.id)) { n.p = ROOT; break; }
      seen.add(n.id);
      n = out[n.p];
    }
  }

  for (const { node, loser } of conflicts) {
    const text = loser + ' (conflict)';
    const dup = Object.values(out).some((x) => x.p === node.p && (x.t === text || x.t === loser));
    if (!dup) {
      const id = newId();
      out[id] = { id, p: node.p, k: node.k + 'V', t: text, d: false, c: false, m: node.m };
    }
  }

  return out;
}
