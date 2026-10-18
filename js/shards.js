// Splitting the outline into per-document pieces ("shards") for storage and
// sync, and packing them compactly.
//
//   index        root, folders, and the document nodes themselves (the sidebar)
//   d:<docId>    everything inside one document
//
// So editing a to-do list only changes (and uploads) that document's shard.
// Shards are stored in Dropbox as gzip-compressed JSON with default values
// left out.

import { ROOT, FIELDS } from './model.js';

export const INDEX = 'index';
export const DIR = '/v2';

// Which shard each node belongs to: Map id -> shard key.
export function shardMap(nodes) {
  const memo = new Map();
  const isContainer = (n) => !!n && (n.id === ROOT || !!n.f);
  const of = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = nodes[id];
    let s;
    if (!n || n.p === null || n.f || isContainer(nodes[n.p])) s = INDEX; // root, folder, document
    else if (!nodes[n.p]) s = INDEX; // orphan (shouldn't happen)
    else {
      const ps = of(n.p);
      s = ps === INDEX ? 'd:' + n.p : ps; // parent is a document, or inside one
    }
    memo.set(id, s);
    return s;
  };
  for (const id of Object.keys(nodes)) of(id);
  return memo;
}

// { shard: { id: node } }
export function split(nodes) {
  const out = {};
  for (const [id, s] of shardMap(nodes)) (out[s] ||= {})[id] = nodes[id];
  return out;
}

// Union of shards. A node found in two shards (a line moved between documents
// on one device while another device was syncing) keeps the newer copy.
export function join(shards) {
  const out = {};
  for (const nodes of Object.values(shards)) {
    for (const [id, n] of Object.entries(nodes)) {
      if (!out[id] || (n.m || 0) > (out[id].m || 0)) out[id] = n;
    }
  }
  return out;
}

export const shardPath = (s) => (s === INDEX ? `${DIR}/index.json.gz` : `${DIR}/docs/${s.slice(2)}.json.gz`);

// Shard key for a Dropbox path (use path_display: ids are case-sensitive).
export function pathShard(path) {
  if (path.toLowerCase() === `${DIR}/index.json.gz`) return INDEX;
  const m = /^\/v2\/docs\/([^/]+)\.json\.gz$/i.exec(path);
  return m ? 'd:' + m[1] : null;
}

// ---------- compact JSON ----------

const DEFAULTS = { d: false, c: false, cl: 0, f: false, h: 0, tb: false, cw: '', hd: false, nb: false };
export const SHARD_FORMAT = 'outliner-shard/1';

export function pack(nodes) {
  const out = {};
  for (const [id, n] of Object.entries(nodes)) {
    const c = {};
    for (const f of [...FIELDS, 'm']) {
      const v = n[f];
      if (v === undefined || (f in DEFAULTS && v === DEFAULTS[f])) continue;
      c[f] = v;
    }
    out[id] = c;
  }
  return JSON.stringify({ format: SHARD_FORMAT, nodes: out });
}

export function unpack(text) {
  const doc = JSON.parse(text);
  if (!doc || doc.format !== SHARD_FORMAT || typeof doc.nodes !== 'object') throw new Error('Not an outliner shard');
  const out = {};
  for (const [id, c] of Object.entries(doc.nodes)) out[id] = { id, ...DEFAULTS, t: '', ...c };
  return out;
}

// ---------- gzip (built into the browser) ----------

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export const isGzip = (bytes) => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
