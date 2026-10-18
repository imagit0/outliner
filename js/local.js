// The outline on this device, in IndexedDB, one record per document (shards,
// see shards.js), so saving after an edit rewrites only what changed.
// On first run it moves the outline over from localStorage (the old store,
// which is limited to about 5 MB).

import { idbKV } from './idb.js';
import { split, join } from './shards.js';
import { sameNodes } from './model.js';
import { load, save } from './store.js';

const P = 'local:';

export class LocalStore {
  constructor(kv = idbKV) {
    this.kv = kv;
    this.saved = {}; // shard -> nodes as last written
    this.chain = Promise.resolve();
  }

  // The saved outline, or null if there is none.
  async load() {
    const entries = await this.kv.entries(P);
    if (entries.length) {
      for (const [k, v] of entries) this.saved[k.slice(P.length)] = v;
      return join(this.saved);
    }
    const old = load('doc');
    if (old) {
      await this.write(old);
      save('doc', null); // only once it's safely in IndexedDB
      return old;
    }
    return null;
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
