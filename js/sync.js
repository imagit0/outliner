// Sync orchestration: keeps the local outline and the cloud file converged.
//
// We remember the last version both sides agreed on ("base") and its Dropbox
// revision. Each sync:
//   1. download the cloud file
//   2. if it is still at our base revision, our local nodes are the new truth;
//      otherwise three-way merge base/local/remote
//   3. upload conditionally on the revision we downloaded; if someone else
//      wrote in between, start over
// Edits made while a sync is in flight are kept by merging them on top.

import * as dropbox from './dropbox.js';
import { SYNC_PATH } from './config.js';
import { merge } from './merge.js';
import { FORMAT, parseDoc, sameNodes } from './model.js';
import { load, save } from './store.js';

export class Sync {
  // getNodes(): current local node map. replaceNodes(map): adopt a merged map.
  // onStatus(state, detail): 'off' | 'syncing' | 'ok' | 'offline' | 'auth' | 'error'
  constructor({ getNodes, replaceNodes, onStatus }) {
    this.getNodes = getNodes;
    this.replaceNodes = replaceNodes;
    this.onStatus = onStatus;
    this.running = false;
    this.again = false;
    this.timer = null;
    this.state = 'off';
  }

  setStatus(state, detail = '') {
    this.state = state;
    this.onStatus(state, detail);
  }

  // Sync after `ms` of quiet (edits keep pushing it back).
  schedule(ms = 3000) {
    if (!dropbox.isConnected()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), ms);
  }

  // Local copy differs from what was last synced?
  get dirty() {
    const base = load('base');
    return !base || !sameNodes(base, this.getNodes());
  }

  async run() {
    clearTimeout(this.timer);
    if (!dropbox.isConnected()) return this.setStatus('off');
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
          if (!(e instanceof dropbox.ConflictError)) throw e;
        }
      }
      save('lastSync', Date.now());
      this.setStatus('ok');
    } catch (e) {
      console.warn('sync failed', e);
      if (e instanceof dropbox.AuthError) this.setStatus(dropbox.isConnected() ? 'error' : 'auth', 'Dropbox sign-in expired');
      else if (!navigator.onLine || e instanceof TypeError) this.setStatus('offline');
      else this.setStatus('error', e.message);
    } finally {
      this.running = false;
      if (this.again || (this.state === 'ok' && this.dirty)) this.schedule(1000);
    }
  }

  async once() {
    const snap = structuredClone(this.getNodes());
    const base = load('base');
    const baseRev = load('baseRev');
    const remote = await dropbox.download(SYNC_PATH);

    let target;
    if (!remote) {
      target = snap;
    } else if (base && remote.rev === baseRev) {
      if (sameNodes(base, snap)) return; // nothing changed anywhere
      target = snap;
    } else {
      const rnodes = parseDoc(remote.text);
      // A brand-new device adopts the cloud copy instead of merging its
      // placeholder item into it.
      target = load('pristine') ? rnodes : merge(base, snap, rnodes);
      this.adopt(snap, target);
      if (sameNodes(target, rnodes)) {
        this.commit(target, remote.rev);
        return;
      }
    }

    const rev = await dropbox.upload(SYNC_PATH, JSON.stringify({ format: FORMAT, nodes: target }), remote ? remote.rev : null);
    this.commit(target, rev);
  }

  // Bring merged changes into the live outline without losing edits made
  // since `snap` was taken.
  adopt(snap, target) {
    const current = this.getNodes();
    const next = sameNodes(snap, current) ? target : merge(snap, current, target);
    if (!sameNodes(next, current)) this.replaceNodes(structuredClone(next));
  }

  commit(nodes, rev) {
    save('base', nodes);
    save('baseRev', rev);
    save('pristine', null);
  }

  forget() {
    save('base', null);
    save('baseRev', null);
    this.setStatus('off');
  }
}
