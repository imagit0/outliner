// Dropbox client: OAuth 2 PKCE sign-in (no server, no secret) plus the two
// file calls sync needs. With an "App folder" Dropbox app, paths are relative
// to Apps/<app name>/.

import { DROPBOX_APP_KEY } from './config.js';
import { load, save } from './store.js';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const CONTENT = 'https://content.dropboxapi.com/2';
const API = 'https://api.dropboxapi.com/2';
const NOTIFY = 'https://notify.dropboxapi.com/2';

export class ConflictError extends Error {}
export class AuthError extends Error {}

const redirectUri = () => location.origin + location.pathname;

export const isConfigured = () => !!DROPBOX_APP_KEY;
export const isConnected = () => !!load('dropbox');

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function connect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('ol.pkce', verifier);
  const q = new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: redirectUri(),
  });
  location.assign(`${AUTH_URL}?${q}`);
}

export function disconnect() {
  const auth = load('dropbox');
  save('dropbox', null);
  if (auth) {
    fetch(`${API}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${auth.access}` } }).catch(() => {});
  }
}

// Call once at startup: finishes sign-in if Dropbox just redirected back here.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', location.pathname + location.hash);
  const verifier = sessionStorage.getItem('ol.pkce');
  sessionStorage.removeItem('ol.pkce');
  if (!q.has('code') || !verifier) return false;
  const tok = await tokenRequest({
    code: q.get('code'),
    grant_type: 'authorization_code',
    code_verifier: verifier,
    client_id: DROPBOX_APP_KEY,
    redirect_uri: redirectUri(),
  });
  save('dropbox', { access: tok.access_token, refresh: tok.refresh_token, exp: Date.now() + tok.expires_in * 1000 });
  return true;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(params) });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new AuthError(await res.text());
    throw new Error(`token ${res.status}`);
  }
  return res.json();
}

async function accessToken(force = false) {
  const auth = load('dropbox');
  if (!auth) throw new AuthError('not connected');
  if (!force && auth.exp - Date.now() > 60_000) return auth.access;
  let tok;
  try {
    tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: DROPBOX_APP_KEY });
  } catch (e) {
    if (e instanceof AuthError) save('dropbox', null); // refresh token revoked
    throw e;
  }
  auth.access = tok.access_token;
  auth.exp = Date.now() + tok.expires_in * 1000;
  save('dropbox', auth);
  return auth.access;
}

// fetch with auth; retries once with a refreshed token on 401.
async function call(url, headers, body) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw new AuthError('unauthorized');
    return res;
  }
}

// Header args must be ASCII; escape anything else.
const apiArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// Returns { text, rev } or null if the file does not exist.
export async function download(path) {
  const res = await call(`${CONTENT}/files/download`, { 'Dropbox-API-Arg': apiArg({ path }) });
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (String(err.error_summary || '').startsWith('path/not_found')) return null;
    throw new Error(`download: ${err.error_summary || 409}`);
  }
  if (!res.ok) throw new Error(`download ${res.status}`);
  const text = await res.text();
  const meta = res.headers.get('Dropbox-API-Result');
  if (meta) return { text, rev: JSON.parse(meta).rev };
  // Fallback if the header is not exposed to us.
  const m = await call(`${API}/files/get_metadata`, { 'Content-Type': 'application/json' }, JSON.stringify({ path }));
  if (!m.ok) throw new Error(`get_metadata ${m.status}`);
  return { text, rev: (await m.json()).rev };
}

async function rpc(endpoint, args) {
  const res = await call(`${API}/${endpoint}`, { 'Content-Type': 'application/json' }, JSON.stringify(args));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(`${endpoint}: ${err.error_summary || res.status}`);
    e.summary = String(err.error_summary || '');
    throw e;
  }
  return res.json();
}

// Current revision of a file (cheap: no content), or null if it doesn't exist.
export async function getRev(path) {
  try {
    return (await rpc('files/get_metadata', { path })).rev;
  } catch (e) {
    if (e.summary && e.summary.startsWith('path/not_found')) return null;
    throw e;
  }
}

// ---- plain files (backups) ----

// Write a file. overwrite=false fails with ConflictError if it exists.
export async function putFile(path, text, overwrite = false) {
  const arg = { path, mode: { '.tag': overwrite ? 'overwrite' : 'add' }, autorename: false, mute: true };
  const res = await call(`${CONTENT}/files/upload`, { 'Dropbox-API-Arg': apiArg(arg), 'Content-Type': 'application/octet-stream' }, text);
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (String(err.error_summary || '').includes('conflict')) throw new ConflictError(err.error_summary);
    throw new Error(`upload: ${err.error_summary || 409}`);
  }
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return res.json();
}

// Files in a folder (not recursive): [{ name, path_lower, ... }]. Empty if
// the folder doesn't exist yet.
export async function listFiles(path) {
  let page;
  try {
    page = await rpc('files/list_folder', { path, recursive: false });
  } catch (e) {
    if (e.summary && e.summary.startsWith('path/not_found')) return [];
    throw e;
  }
  const entries = [...page.entries];
  while (page.has_more) {
    page = await rpc('files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return entries.filter((e) => e['.tag'] === 'file');
}

export async function deleteFile(path) {
  await rpc('files/delete_v2', { path });
}

// ---- change notifications ----
// A cursor marks a point in the app folder's history; longpoll() holds the
// request open until something changes after it (or the timeout passes).

export async function latestCursor() {
  return (await rpc('files/list_folder/get_latest_cursor', { path: '', recursive: false })).cursor;
}

// Resolves { changes: bool, backoff?: seconds }. Needs no auth.
export async function longpoll(cursor, signal, timeout = 120) {
  const res = await fetch(`${NOTIFY}/files/list_folder/longpoll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, timeout }),
    signal,
  });
  if (!res.ok) throw new Error(`longpoll ${res.status}`);
  return res.json();
}

// Entries changed since `cursor`, and the new cursor.
export async function changesSince(cursor) {
  const entries = [];
  let page = { cursor, has_more: true };
  while (page.has_more) {
    page = await rpc('files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return { entries, cursor: page.cursor };
}

// Uploads only if the file is still at `rev` (or does not exist, when rev is
// null). Throws ConflictError if someone else wrote it first. Returns new rev.
export async function upload(path, text, rev) {
  const arg = { path, mode: rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' }, autorename: false, mute: true };
  const res = await call(`${CONTENT}/files/upload`, { 'Dropbox-API-Arg': apiArg(arg), 'Content-Type': 'application/octet-stream' }, text);
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (String(err.error_summary || '').includes('conflict')) throw new ConflictError(err.error_summary);
    throw new Error(`upload: ${err.error_summary || 409}`);
  }
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return (await res.json()).rev;
}
