// Sync orchestration: keeps the local outline and Dropbox converged.
//
// In Dropbox the outline is split into one compressed file per document plus
// an index file for the sidebar (see shards.js), so a small edit uploads only
// the document it touched.
//
// We remember, per file, the version both sides last agreed on ("base") and
// its Dropbox revision. Each sync:
//   1. ask Dropbox which files changed since last time (a cheap listing)
//   2. download only those files
//   3. three-way merge base / local / remote over the whole outline (so
//      structure checks see everything), exactly as before
//   4. upload only the files whose merged content differs from what Dropbox
//      has, each conditional on the revision we know; if someone else wrote
//      in between, start over
// Edits made while a sync is in flight are kept by merging them on top.
//
// The first device to run this version moves the old single /outline.json
// into the new layout and renames it to /outline-before-split.json.

import * as dropbox from './dropbox.js';
import { idbKV } from './idb.js';
import { merge } from './merge.js';
import { parseDoc, sameNodes } from './model.js';
import { load, save } from './store.js';
import { DIR, split, join, shardPath, pathShard, pack, unpack, gzip, gunzip, isGzip } from './shards.js';

const MAX_WAIT = 4000;
const LEGACY = '/outline.json';
const LEGACY_DONE = '/outline-before-split.json';
const decoder = new TextDecoder();

export class Sync {
  // getNodes(): current local node map. replaceNodes(map): adopt a merged map.
  // onStatus(state, detail): 'off' | 'syncing' | 'ok' | 'offline' | 'auth' | 'error'
  // remote / kv: Dropbox and IndexedDB by default (replaceable in tests).
  constructor({ getNodes, replaceNodes, onStatus, remote = dropbox, kv = idbKV }) {
    this.getNodes = getNodes;
    this.replaceNodes = replaceNodes;
    this.onStatus = onStatus;
    this.remote = remote;
    this.kv = kv;
    this.running = false;
    this.again = false;
    this.timer = null;
    this.state = 'off';
    this.base = {}; // shard -> { nodes, rev }
    this.cursor = null;
  }

  // Load the sync state saved on this device.
  async init() {
    this.base = {};
    for (const [k, v] of await this.kv.entries('base:')) this.base[k.slice(5)] = v;
    this.cursor = (await this.kv.get('cursor')) || null;
  }

  // The outline as of the last successful sync.
  baseNodes() {
    return join(Object.fromEntries(Object.entries(this.base).map(([s, b]) => [s, b.nodes])));
  }

  setStatus(state, detail = '') {
    this.state = state;
    this.onStatus(state, detail);
  }

  // Sync after `ms` of quiet. Edits keep pushing it back, but never more than
  // MAX_WAIT after the first unsynced edit, so long typing streaks still sync.
  schedule(ms = 1000) {
    if (!this.remote.isConnected()) return;
    clearTimeout(this.timer);
    if (!this.pendingSince) this.pendingSince = Date.now();
    const wait = Math.min(ms, Math.max(0, this.pendingSince + MAX_WAIT - Date.now()));
    this.timer = setTimeout(() => this.run(), wait);
  }

  // Listen for changes made by other devices while the app is visible.
  startWatching() {
    if (this.watchAbort || !this.remote.isConnected()) return;
    const abort = (this.watchAbort = new AbortController());
    this.watch(abort.signal);
  }

  stopWatching() {
    if (this.watchAbort) this.watchAbort.abort();
    this.watchAbort = null;
  }

  async watch(signal) {
    const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
    let cursor = null;
    while (!signal.aborted && this.remote.isConnected()) {
      try {
        if (!cursor) cursor = await this.remote.latestCursor();
        const res = await this.remote.longpoll(cursor, signal);
        if (res.changes) {
          const page = await this.remote.changesSince(cursor);
          cursor = page.cursor;
          // Our own uploads show up here too; only sync for someone else's.
          const foreign = page.entries.some((e) => {
            const path = e.path_display || e.path_lower || '';
            if (path.toLowerCase() === LEGACY) return true;
            const s = pathShard(path);
            return s && (this.base[s]?.rev || null) !== (e.rev || null);
          });
          if (foreign) this.run();
        }
        if (res.backoff) await sleep(res.backoff);
      } catch (e) {
        if (signal.aborted || e instanceof this.remote.AuthError) break;
        cursor = null;
        await sleep(15);
      }
    }
    if (this.watchAbort && this.watchAbort.signal === signal) this.watchAbort = null;
  }

  // Local copy differs from what was last synced?
  get dirty() {
    return !sameNodes(this.baseNodes(), this.getNodes());
  }

  async run() {
    clearTimeout(this.timer);
    this.pendingSince = null;
    if (!this.remote.isConnected()) return this.setStatus('off');
    if (this.running) { this.again = true; return; }
    this.running = true;
    this.again = false;
    this.setStatus('syncing');
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt >= 5) throw new Error('kept conflicting; will retry');
        try {
          await this.once();
          break;
        } catch (e) {
          if (!(e instanceof this.remote.ConflictError)) throw e;
        }
      }
      save('lastSync', Date.now());
      this.setStatus('ok');
    } catch (e) {
      console.warn('sync failed', e);
      if (e instanceof this.remote.AuthError) this.setStatus(this.remote.isConnected() ? 'error' : 'auth', 'Dropbox sign-in expired');
      else if (!navigator.onLine || e instanceof TypeError) this.setStatus('offline');
      else this.setStatus('error', e.message);
    } finally {
      this.running = false;
      if (this.again || (this.state === 'ok' && this.dirty)) this.schedule(1000);
    }
  }

  async once() {
    const snap = structuredClone(this.getNodes());
    const R = this.remote;

    // 1. Which files changed in Dropbox since our last sync?
    let listing = null;
    let full = !this.cursor;
    if (this.cursor) {
      try {
        listing = await R.listSince(this.cursor);
      } catch (e) {
        if (!(e instanceof R.ResetError)) throw e;
        full = true;
      }
    }
    if (full) listing = await R.listAll(DIR); // null: folder doesn't exist yet

    const revs = {}; // shard -> rev now in Dropbox (null = absent)
    for (const [s, b] of Object.entries(this.base)) revs[s] = full ? null : b.rev;
    for (const e of listing?.entries || []) {
      const s = pathShard(e.path);
      if (!s) continue;
      if (e.tag === 'file') revs[s] = e.rev;
      else if (e.tag === 'deleted') revs[s] = null;
    }
    const changed = Object.keys(revs).filter((s) => (revs[s] || null) !== (this.base[s]?.rev || null));

    // First run of this version: bring the old single file over.
    let legacy = null;
    if (!Object.keys(this.base).length && !Object.values(revs).some(Boolean)) legacy = await this.loadLegacy();

    // 2. Download what changed.
    const remoteShards = {};
    for (const [s, b] of Object.entries(this.base)) remoteShards[s] = b.nodes;
    for (const s of changed) {
      if (!revs[s]) { delete remoteShards[s]; continue; }
      const got = await this.fetchShard(s);
      if (got) { remoteShards[s] = got.nodes; revs[s] = got.rev; } else { delete remoteShards[s]; revs[s] = null; }
    }

    const remoteChanged = changed.length > 0 || !!legacy;
    const base = legacy ? legacy.base : this.baseNodes();
    const remoteNodes = legacy ? legacy.nodes : join(remoteShards);
    if (!remoteChanged && sameNodes(base, snap)) return this.saveCursor(listing);

    // 3. Merge. A brand-new device adopts the cloud copy instead of merging
    // its placeholder item into it.
    let target = snap;
    if (remoteChanged) {
      const remoteHasContent = Object.keys(remoteNodes).length > 1;
      target = load('pristine') && remoteHasContent ? remoteNodes : merge(base, snap, remoteNodes);
      this.adopt(snap, target);
    }

    // 4. Upload the files whose content differs from Dropbox's.
    const targetShards = split(target);
    const onServer = legacy ? {} : remoteShards;
    const next = {};
    for (const s of new Set([...Object.keys(targetShards), ...Object.keys(onServer)])) {
      const t = targetShards[s] || {};
      const rev = legacy ? null : revs[s] || null;
      const empty = !Object.keys(t).length;
      if (sameNodes(t, onServer[s] || {})) {
        if (!empty) next[s] = { nodes: t, rev };
        continue;
      }
      if (empty) {
        if (rev) await R.deleteRev(shardPath(s), rev); // document deleted here
        continue;
      }
      next[s] = { nodes: t, rev: await R.putBytes(shardPath(s), await gzip(pack(t)), rev) };
    }

    await this.commit(next, listing);
    if (legacy) {
      try { await R.moveFile(LEGACY, LEGACY_DONE); } catch (e) { console.warn('could not rename old outline.json', e); }
    }
  }

  // The pre-split single file, with this device's last synced copy of it.
  async loadLegacy() {
    const got = await this.remote.download(LEGACY);
    if (!got) return null;
    const oldBase = load('base');
    return { nodes: parseDoc(got.text), base: oldBase && load('baseRev') ? oldBase : {} };
  }

  async fetchShard(s) {
    const got = await this.remote.getBytes(shardPath(s));
    if (!got) return null;
    const text = isGzip(got.bytes) ? await gunzip(got.bytes) : decoder.decode(got.bytes);
    return { nodes: unpack(text), rev: got.rev };
  }

  // Bring merged changes into the live outline without losing edits made
  // since `snap` was taken.
  adopt(snap, target) {
    const current = this.getNodes();
    const next = sameNodes(snap, current) ? target : merge(snap, current, target);
    if (!sameNodes(next, current)) this.replaceNodes(structuredClone(next));
  }

  async commit(next, listing) {
    const ops = [];
    for (const s of Object.keys(this.base)) if (!next[s]) ops.push(['base:' + s, undefined]);
    for (const [s, b] of Object.entries(next)) {
      const old = this.base[s];
      if (!old || old.rev !== b.rev || !sameNodes(old.nodes, b.nodes)) ops.push(['base:' + s, b]);
    }
    if (listing?.cursor) ops.push(['cursor', listing.cursor]);
    await this.kv.batch(ops);
    this.base = next;
    if (listing?.cursor) this.cursor = listing.cursor;
    save('pristine', null);
    // The pre-split sync state (single file) is no longer needed.
    save('base', null);
    save('baseRev', null);
  }

  async saveCursor(listing) {
    if (!listing?.cursor || listing.cursor === this.cursor) return;
    this.cursor = listing.cursor;
    await this.kv.put('cursor', listing.cursor);
  }

  async forget() {
    this.stopWatching();
    const ops = Object.keys(this.base).map((s) => ['base:' + s, undefined]);
    ops.push(['cursor', undefined]);
    await this.kv.batch(ops);
    this.base = {};
    this.cursor = null;
    save('base', null);
    save('baseRev', null);
    this.setStatus('off');
  }
}
