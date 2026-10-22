// Sync tests: two simulated devices against a simulated Dropbox (files with
// revisions, conditional writes, a change log for cursors).

import { Outline, ROOT, sameNodes } from '../js/model.js';
import { Sync } from '../js/sync.js';
import { memoryKV } from '../js/idb.js';
import { LocalStore, takeNewerSynced } from '../js/local.js';
import { remapColors, V37, V38, V39 } from '../js/migrate.js';
import { split, join, pack, unpack, gzip, gunzip, shardMap, INDEX } from '../js/shards.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

export function fakeDropbox() {
  class ConflictError extends Error {}
  class ResetError extends Error {}
  class AuthError extends Error {}
  const files = new Map(); // lower-case path -> { path, bytes, rev }
  const log = []; // { path, rev|null }
  const stats = { up: 0, upBytes: 0, down: 0, lists: 0 };
  let revN = 0;
  const key = (p) => p.toLowerCase();
  const change = (path, rev) => log.push({ path, rev });
  const api = {
    ConflictError, ResetError, AuthError,
    isConnected: () => true,
    async listAll(dir) {
      await tick();
      stats.lists++;
      const d = key(dir) + '/';
      const entries = [...files.values()].filter((f) => key(f.path).startsWith(d)).map((f) => ({ tag: 'file', path: f.path, rev: f.rev }));
      if (!entries.length && dir) return null; // folder missing (the root always exists)
      return { entries, cursor: String(log.length) };
    },
    async listSince(c) {
      await tick();
      stats.lists++;
      const latest = new Map();
      for (const e of log.slice(+c)) latest.set(key(e.path), e);
      const entries = [...latest.values()]
        .map((e) => (e.rev ? { tag: 'file', path: e.path, rev: e.rev } : { tag: 'deleted', path: e.path, rev: null }));
      return { entries, cursor: String(log.length) };
    },
    async getBytes(p) {
      await tick();
      stats.down++;
      const f = files.get(key(p));
      return f ? { bytes: f.bytes.slice(), rev: f.rev } : null;
    },
    async putBytes(p, bytes, rev) {
      await tick();
      const f = files.get(key(p));
      if ((f?.rev || null) !== (rev || null)) throw new ConflictError('conflict');
      const nr = 'r' + ++revN;
      files.set(key(p), { path: p, bytes, rev: nr });
      change(p, nr);
      stats.up++;
      stats.upBytes += bytes.length;
      return nr;
    },
    async deleteRev(p, rev) {
      await tick();
      const f = files.get(key(p));
      if (f) {
        if (rev && f.rev !== rev) throw new ConflictError('conflict');
        files.delete(key(p));
        change(p, null);
        return;
      }
      for (const [k, g] of [...files]) { // a folder: everything under it
        if (k.startsWith(key(p) + '/')) { files.delete(k); change(g.path, null); }
      }
    },
  };
  const reset = () => { stats.up = stats.upBytes = stats.down = stats.lists = 0; };
  return { api, files, stats, reset };
}

// A device: its own outline, its own storage, sharing the fake Dropbox.
// Pass the kv of an earlier device (and its nodes) to simulate a reload.
export async function device(server, nodes, kv = memoryKV()) {
  const o = new Outline(structuredClone(nodes));
  const dev = { o, status: '', kv };
  dev.s = new Sync({
    getNodes: () => o.nodes,
    replaceNodes: (n) => { o.nodes = n; o.invalidate(); },
    onStatus: (st, d) => { dev.status = st + (d ? ': ' + d : ''); },
    remote: server.api,
    kv,
  });
  dev.s.schedule = () => {}; // tests drive syncs explicitly
  await dev.s.init();
  dev.sync = async () => {
    await dev.s.run();
    if (dev.status !== 'ok') throw new Error('sync status ' + dev.status);
  };
  return dev;
}

// Sample outline: an index (folder + 2 docs) and content in both docs.
function sample() {
  const o = new Outline();
  const f = o.insert(ROOT, null, { t: 'Folder', f: true });
  const todo = o.insert(f.id, null, { t: 'To do' });
  const notes = o.insert(ROOT, f.id, { t: 'Notes' });
  let prev = null;
  for (let i = 0; i < 5; i++) prev = o.insert(todo.id, prev, { t: 'task ' + i }).id;
  prev = null;
  for (let i = 0; i < 200; i++) prev = o.insert(notes.id, prev, { t: 'a fairly long note line number ' + i + ' with some words in it' }).id;
  return { nodes: o.nodes, todo: todo.id, notes: notes.id };
}

const texts = (o, pid) => o.children(pid).map((n) => n.t);
const withLocal = (fn) => {
  // Sync reads/writes a few flags in localStorage ('ol.*'); keep tests clean.
  const keys = ['ol.pristine', 'ol.lastSync'];
  const saved = keys.map((k) => localStorage.getItem(k));
  keys.forEach((k) => localStorage.removeItem(k));
  return Promise.resolve(fn()).finally(() => keys.forEach((k, i) => (saved[i] === null ? localStorage.removeItem(k) : localStorage.setItem(k, saved[i]))));
};

export function syncTests(test, { eq, ok }) {
  test('shards: split by document, join back, pack/unpack, gzip', async () => {
    const { nodes, todo, notes } = sample();
    const sh = split(nodes);
    eq(Object.keys(sh).sort(), [INDEX, 'd:' + notes, 'd:' + todo].sort());
    eq(Object.keys(sh[INDEX]).length, 4, 'root, folder, 2 docs');
    ok(sameNodes(join(sh), nodes), 'join');
    const packed = pack(sh['d:' + notes]);
    ok(!packed.includes('"d":false') && !packed.includes('"cl":0'), 'defaults left out');
    ok(sameNodes(unpack(packed), sh['d:' + notes]), 'unpack');
    const z = await gzip(packed);
    ok(z.length < packed.length / 3, `compressed ${packed.length} -> ${z.length}`);
    eq(await gunzip(z), packed);
    eq(shardMap(nodes).get(todo), INDEX);
  });

  test('sync: first device uploads an index plus one file per document', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo, notes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const paths = [...server.files.values()].map((f) => f.path).sort();
    eq(paths, ['/docs/' + notes + '.json.gz', '/docs/' + todo + '.json.gz', '/index.json.gz'].sort());
    ok(sameNodes(A.o.nodes, nodes), 'outline unchanged');
  }));

  test('sync: second device joins, edits upload only their document', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo, notes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes); // same data, e.g. from the old version
    server.reset();
    await B.sync();
    eq(server.stats.up, 0, 'nothing to upload');
    ok(sameNodes(A.o.nodes, B.o.nodes));

    // A ticks off a task: one small upload.
    const task = A.o.children(todo)[2];
    A.o.update(task.id, { d: true });
    server.reset();
    await A.sync();
    eq(server.stats.up, 1, 'one file uploaded');
    const fullSize = (await gzip(pack(A.o.nodes))).length;
    ok(server.stats.upBytes < fullSize / 5, `uploaded ${server.stats.upBytes} bytes vs ${fullSize} for everything`);

    // B picks it up by downloading just that file.
    server.reset();
    await B.sync();
    eq(server.stats.down, 1, 'one file downloaded');
    eq(B.o.get(task.id).d, true);
    ok(sameNodes(A.o.nodes, B.o.nodes));
    void notes;
  }));

  test('sync: edits in different documents on both devices merge', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo, notes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes);
    await B.sync();
    A.o.insert(todo, null, { t: 'new task from A' });
    const line = B.o.children(notes)[10];
    B.o.update(line.id, { t: 'edited on B' });
    await A.sync();
    await B.sync();
    await A.sync();
    eq(A.o.children(todo)[0].t, 'new task from A');
    eq(A.o.get(line.id).t, 'edited on B');
    ok(sameNodes(A.o.nodes, B.o.nodes));
  }));

  test('sync: both devices syncing at once (conflicting writes retry)', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes);
    await B.sync();
    const [t0, t1] = A.o.children(todo);
    A.o.update(t0.id, { t: 'A was here' });
    B.o.update(t1.id, { t: 'B was here' });
    await Promise.all([A.sync(), B.sync()]); // same file, interleaved
    await A.sync();
    await B.sync();
    eq(texts(A.o, todo).slice(0, 2), ['A was here', 'B was here']);
    ok(sameNodes(A.o.nodes, B.o.nodes));
  }));

  test('sync: same line edited on both devices keeps both texts', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes);
    await B.sync();
    const id = A.o.children(todo)[0].id;
    A.o.update(id, { t: 'version A' });
    B.o.update(id, { t: 'version B' });
    await A.sync();
    await B.sync();
    await A.sync();
    const all = texts(A.o, todo).join(' | ');
    ok(all.includes('version A') && all.includes('version B'), all);
    ok(sameNodes(A.o.nodes, B.o.nodes));
  }));

  test('sync: moving a line between documents (even while it is edited elsewhere) loses nothing', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, todo, notes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes);
    await B.sync();
    const id = A.o.children(notes)[0].id;
    A.o.move(id, todo, null); // A moves it into To do
    B.o.update(id, { t: 'edited on B meanwhile' }); // B edits it in Notes
    await A.sync();
    await B.sync();
    await A.sync();
    const where = Object.values(A.o.nodes).filter((n) => n.id === id);
    eq(where.length, 1, 'one node with that id');
    eq(A.o.get(id).t, 'edited on B meanwhile', 'edit kept');
    ok(sameNodes(A.o.nodes, B.o.nodes));
  }));

  test('sync: deleting a document removes its file everywhere', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes, notes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const B = await device(server, nodes);
    await B.sync();
    A.o.remove(notes);
    await A.sync();
    ok(![...server.files.values()].some((f) => f.path.includes(notes)), 'file deleted');
    await B.sync();
    ok(!B.o.get(notes), 'gone on B');
    ok(sameNodes(A.o.nodes, B.o.nodes));
  }));

  test('sync: a brand-new device adopts the cloud copy', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    const fresh = Outline.empty();
    localStorage.setItem('ol.pristine', 'true');
    const C = await device(server, fresh.nodes);
    await C.sync();
    ok(sameNodes(C.o.nodes, A.o.nodes), 'placeholder not merged in');
  }));

  test('sync: nothing changed = only a listing, no transfers', () => withLocal(async () => {
    const server = fakeDropbox();
    const { nodes } = sample();
    const A = await device(server, nodes);
    await A.sync();
    server.reset();
    await A.sync();
    eq([server.stats.up, server.stats.down], [0, 0]);
    eq(server.stats.lists, 1);
  }));

  test('local storage: edits to lines loaded at startup are saved (reorder, text)', async () => {
    const kv = memoryKV();
    const { nodes, todo } = sample();
    await new LocalStore(kv).save(nodes);
    // "Reload": load, then edit existing nodes in place, as the app does.
    const store = new LocalStore(kv);
    const o = new Outline(await store.load());
    const [first, second] = o.children(todo);
    o.move(second.id, todo, null); // reorder
    o.update(first.id, { t: 'edited after reload' });
    const docs = o.children(ROOT);
    o.move(docs[docs.length - 1].id, ROOT, null); // reorder documents
    await store.save(o.nodes);
    const again = await new LocalStore(kv).load();
    ok(sameNodes(again, o.nodes), 'saved after reload');
    eq(again[first.id].t, 'edited after reload');
  });

  test('repair: stale device copy takes the newer synced version', () => {
    const { nodes, todo } = sample();
    const local = structuredClone(nodes);
    const synced = structuredClone(nodes);
    const id = Object.values(synced).find((n) => n.p === todo).id;
    synced[id] = { ...synced[id], t: 'synced edit', m: synced[id].m + 1000 };
    const mine = Object.values(local).find((n) => n.p === todo && n.id !== id).id;
    local[mine] = { ...local[mine], t: 'unsynced local edit', m: local[mine].m + 2000 };
    eq(takeNewerSynced(local, synced), 1);
    eq(local[id].t, 'synced edit', 'stale line updated');
    eq(local[mine].t, 'unsynced local edit', 'newer local edit kept');
  });

  test('local storage: one record per document, saves only what changed', async () => {
    const kv = memoryKV();
    const store = new LocalStore(kv);
    const { nodes, todo } = sample();
    eq(await store.load(), null, 'empty at first');
    await store.save(nodes);
    eq([...kv.map.keys()].filter((k) => k.startsWith('local:')).length, 3);
    const o = new Outline(structuredClone(nodes));
    o.update(o.children(todo)[0].id, { t: 'changed' });
    let writes = 0;
    const orig = kv.batch;
    kv.batch = async (ops) => { writes += ops.length; return orig(ops); };
    await store.save(o.nodes);
    eq(writes, 1, 'one document rewritten');
    const again = await new LocalStore(kv).load();
    ok(sameNodes(again, o.nodes), 'reload');
  });

  // Colored lines from every era (see migrate.js), plus uncolored ones.
  const CUTS = { V37, V38, V39: V38 + 3_600_000 };
  const ERA = { orig: V37 - 60_000, v37: V37 + 60_000, v38: V38 + 60_000, now: CUTS.V39 + 60_000 };
  const CASES = [
    // [era, color now, expected color]
    ['orig', 1, 1], ['orig', 2, 2], ['orig', 3, 3], ['orig', 4, 5], ['orig', 5, 6], ['orig', 6, 7],
    ['v37', 2, 2], ['v37', 7, 4], ['v37', 9, 5],
    ['v38', 1, 1], ['v38', 3, 2], ['v38', 4, 3], ['v38', 6, 5], ['v38', 7, 6], ['v38', 9, 7], ['v38', 5, 3], ['v38', 8, 5],
    ['now', 8, 8], ['now', 4, 4], ['orig', 0, 0], ['v38', 0, 0],
  ];
  const MOVED = CASES.filter(([, a, b]) => a !== b).length;
  const EXPECTED = CASES.map(([, , b]) => b);
  const colored = () => {
    const { nodes, notes } = sample();
    const o = new Outline(nodes);
    const lines = o.children(notes);
    CASES.forEach(([era, cl], i) => Object.assign(lines[i + 1], { cl, m: ERA[era] }));
    return { nodes: o.nodes, ids: lines.slice(1, CASES.length + 1).map((n) => n.id) };
  };
  const colorsOf = (o, ids) => ids.map((id) => o.get(id).cl || 0);

  test('colors: each era of line colors moves to the v39 scale exactly once', () => {
    eq([V37, V38], [1792675596000, 1792675804000], 'release times');
    ok(V39 > V38 && V39 < V38 + 86_400_000, 'V39 is set to the release time');
    const { nodes, ids } = colored();
    const o = new Outline(structuredClone(nodes));
    eq(remapColors(o, CUTS), MOVED);
    eq(colorsOf(o, ids), EXPECTED);
    eq(remapColors(o, CUTS), 0, 'second run changes nothing');
    eq(colorsOf(o, ids), EXPECTED);
  });

  test('colors: two devices remapping (in either order) never remap twice', () => withLocal(async () => {
    const { nodes, ids } = colored();
    // Both remap their own copy, then sync.
    let server = fakeDropbox();
    let A = await device(server, nodes);
    await A.sync();
    let B = await device(server, nodes);
    await B.sync();
    remapColors(A.o, CUTS);
    remapColors(B.o, CUTS);
    await A.sync(); await B.sync(); await A.sync();
    eq(colorsOf(A.o, ids), EXPECTED, 'A');
    eq(colorsOf(B.o, ids), EXPECTED, 'B');
    // A remaps and syncs first; B gets the result, then runs its own remap.
    server = fakeDropbox();
    A = await device(server, nodes);
    await A.sync();
    B = await device(server, nodes);
    await B.sync();
    remapColors(A.o, CUTS);
    await A.sync();
    await B.sync();
    eq(remapColors(B.o, CUTS), 0, 'B has nothing left to remap');
    await B.sync(); await A.sync();
    eq(colorsOf(A.o, ids), EXPECTED, 'A after');
    eq(colorsOf(B.o, ids), EXPECTED, 'B after');
  }));
}