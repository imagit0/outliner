// Daily backups to Dropbox: /backups/outline-YYYY-MM-DD.json in the app
// folder. A web app can't run in the background, so "daily" means: the
// first successful sync of each day, on whichever device gets there first.
// Older backups beyond the chosen number of days are deleted.

import * as dropbox from './dropbox.js';
import { FORMAT } from './model.js';
import { load, save } from './store.js';

const DIR = '/backups';
const NAME = /^outline-(\d{4}-\d{2}-\d{2})\.json$/;

// Local date as YYYY-MM-DD.
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// keep: days of backups to keep (0 = backups off, -1 = keep all).
// force: write today's backup even if one exists (Back up now).
// Returns 'saved', 'exists' (another device already did today's), or 'off'.
export async function backup(nodes, keep, force = false) {
  if (!keep || !dropbox.isConnected()) return 'off';
  const day = today();
  if (!force && load('lastBackup') === day) return 'exists';
  const text = JSON.stringify({ format: FORMAT, nodes });
  let result = 'saved';
  try {
    await dropbox.putFile(`${DIR}/outline-${day}.json`, text, force);
  } catch (e) {
    if (!(e instanceof dropbox.ConflictError)) throw e;
    result = 'exists';
  }
  save('lastBackup', day);
  if (keep > 0) await prune(keep);
  return result;
}

// Delete backups older than `keep` days.
async function prune(keep) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keep + 1);
  const limit = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  for (const f of await dropbox.listFiles(DIR)) {
    const m = NAME.exec(f.name);
    if (m && m[1] < limit) await dropbox.deleteFile(f.path_lower);
  }
}
