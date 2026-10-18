// The outline on this device, in IndexedDB, one record per document (shards,
// see shards.js), so saving after an edit rewrites only what changed.

import { idbKV } from './idb.js';
import { split, join } from './shards.js';
import { sameNodes, sameNode } from './model.js';

const P = 'local:';

// Repair for a bug (fixed 2026-10-19): edits to lines loaded at startup were
// not saved on the device, though they did sync. So the device's copy of such
// a line can be older than the last synced one; take the synced version
// wherever it is newer. Returns how many lines were updated.
export function takeNewerSynced(nodes, synced) {
  let n = 0;
  for (const [id, b] of Object.entries(synced)) {
    const l = nodes[id];
    if (l && (b.m || 0) > (l.m || 0) && !sameNode(l, b)) {
      nodes[id] = structuredClone(b);
      n++;
    }
  }
  return n;
}

export class LocalStore {
  constructor(kv = idbKV) {
    this.kv = kv;
    this.saved = {}; // shard -> nodes as last written
    this.chain = Promise.resolve();
  }

  // The saved outline, or null if there is none.
  async load() {
    const entries = await this.kv.entries(P);
    if (!entries.length) return null;
    for (const [k, v] of entries) this.saved[k.slice(P.length)] = v;
    // A separate copy: the outline edits its nodes in place, and `saved` must
    // keep what's on disk or edits would look unchanged and never be written.
    return structuredClone(join(this.saved));
  }

  // Save (serialized, so overlapping saves can't interleave).
  save(nodes) {
    this.chain = this.chain.then(() => this.write(nodes));
    return this.chain;
  }

  async write(nodes) {
    const shards = split(nodes);
    const ops = [];
    for (const s of Object.keys(this.saved)) if (!shards[s]) ops.push([P + s, undefined]);
    for (const [s, n] of Object.entries(shards)) {
      if (!this.saved[s] || !sameNodes(this.saved[s], n)) ops.push([P + s, n]);
    }
    if (!ops.length) return;
    await this.kv.batch(ops);
    for (const [k, v] of ops) {
      const s = k.slice(P.length);
      if (v === undefined) delete this.saved[s];
      else this.saved[s] = structuredClone(v);
    }
  }
}
