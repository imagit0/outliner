// Local persistence (localStorage). Everything is namespaced under "ol.".

const P = 'ol.';

export function load(key, fallback = null) {
  try {
    const s = localStorage.getItem(P + key);
    return s === null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(P + key);
    else localStorage.setItem(P + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('save failed', key, e);
    return false;
  }
}

// Ask the browser not to evict our storage (installed PWAs usually get this).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* not supported */ }
}
