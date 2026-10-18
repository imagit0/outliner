// Tiny key-value store on IndexedDB (no size limit worth worrying about,
// unlike localStorage's ~5 MB). Used for the outline itself and the sync
// state; small settings stay in localStorage (store.js).
//
// Interface (shared with memoryKV for tests):
//   get(key), put(key, value), del(key), entries(prefix) -> [[key, value]]

const DB = 'outliner';
const STORE = 'kv';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  }));
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export const idbKV = {
  get: (key) => tx('readonly', (s) => req(s.get(key))),
  put: (key, value) => tx('readwrite', (s) => { s.put(value, key); }),
  del: (key) => tx('readwrite', (s) => { s.delete(key); }),
  // Several writes in one transaction: ops = [[key, value | undefined(delete)]]
  batch: (ops) => tx('readwrite', (s) => { for (const [k, v] of ops) v === undefined ? s.delete(k) : s.put(v, k); }),
  entries: (prefix) => tx('readonly', async (s) => {
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const [keys, values] = await Promise.all([req(s.getAllKeys(range)), req(s.getAll(range))]);
    return keys.map((k, i) => [k, values[i]]);
  }),
};

// Same interface, in memory (tests).
export function memoryKV() {
  const m = new Map();
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    get: async (k) => clone(m.get(k)),
    put: async (k, v) => { m.set(k, clone(v)); },
    del: async (k) => { m.delete(k); },
    batch: async (ops) => { for (const [k, v] of ops) v === undefined ? m.delete(k) : m.set(k, clone(v)); },
    entries: async (p) => [...m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k, clone(v)]),
    map: m,
  };
}
