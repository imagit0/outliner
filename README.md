# Outliner

A simple Dynalist-style outliner. It's an installable web app (PWA): you install it from the browser on Windows (Edge/Chrome) and Android (Chrome), it works offline, and it syncs through Dropbox.

No build step: plain HTML/CSS/ES modules.

## Features

- Multiple documents in nested folders, shown in a sidebar (a slide-out drawer on phones). You can create, rename, duplicate and delete (undoably) documents and folders, and drag them to reorder or move them into folders. Use each entry's **⋯** menu, or right-click it on desktop.
- The ⋯ left of a document's title: Delete completed items, Expand all, Collapse all (for the document, or the item you're zoomed into).
- Right-click an item's bullet for a menu: zoom, complete, collapse, color, heading, duplicate, move to document, delete. Right-clicking text still gives the browser's menu (spelling, cut/copy/paste).
- Nested bullets: Enter, Tab / Shift+Tab, move, collapse, complete (strikethrough), hide completed
- Line colors: Ctrl+1–6 (a spectrum from red to green), Ctrl+0 to clear
- Drag and drop: drag a bullet to move an item (long-press first on touch). Drop it on a sidebar document to move it there, or between documents to turn it into a document.
- Each line has a dot, or a triangle if it has children (click it to collapse or expand); drag either one to move the line
- Zoom into any item with the magnifier that appears when you hover a line (or Alt+→, or the toolbar's zoom button on phones). Breadcrumbs show where you are, and the Android back button zooms back out.
- Search the current document, or all documents with the **All** button. All words must match; matching items are shown with their parents.
- Inline `**bold**` (Ctrl+B), `__italic__` (Ctrl+I), `~~strikethrough~~` (Ctrl+T), `==highlight==` (Ctrl+H), `` `code` ``, `[text](url)` links (Ctrl+K) and plain web addresses (Dynalist syntax)
- Image links: `![caption](url)` or `!https://…` show a preview on hover (tap on phones)
- Tables (Ctrl+Alt+T or ▦ on phones): every cell is an ordinary line. Columns size to their content and wrap when the table gets too wide. A toolbar appears above the table while you edit a cell: add/remove rows and columns, delete the table. In a table, Tab moves to the next cell, Enter moves down a row (or adds one at the bottom), and Ctrl+Alt+arrows insert rows and columns. Ctrl+Shift+0–6 colors a whole row. Drag a column's right edge to set its width (double-click the edge to go back to automatic). The toolbar's **Header** button styles the first row as a header, and **Borders** turns cell borders on or off (with borders off, colored cells touch).
- Import OPML (⋮ → Import OPML…): choose several files, or a folder, or drag any mix of OPML files and folders onto the window. Each file becomes a document; each folder becomes a folder, with everything inside it imported recursively (folders that contain no OPML are skipped). Everything is added at the end of the sidebar, with imported lines collapsed, and one undo removes the whole import.
- OPML export (current document). Tables survive the round trip through extra attributes, and other outliners show them as nested bullets. OPML exported from Dynalist imports with completion, colors and notes (notes become child lines).
- Ctrl+Shift+Backspace deletes an item, Ctrl+D duplicates it, Ctrl+. expands or collapses it, Ctrl+Shift+M moves it to another document, Ctrl+, opens Settings. Ctrl+Shift+Tab outdents a line but keeps its place (the lines below it become its children).
- Select several lines by dragging across them with the mouse (or Shift+click). Then Delete, Ctrl+C / Ctrl+X (as indented text), Tab / Shift+Tab, Ctrl+0–6, Ctrl+Enter and Ctrl+D act on all of them.
- Ctrl+` formats code. Ctrl+Shift+H switches image links between preview-on-hover and showing the images inline (also in Settings).
- An empty document starts with a blank first line with the cursor in it
- Headings, 3 levels (Ctrl+Alt+1–3, Ctrl+Alt+0 for normal text)
- Settings (⋮ → Settings, or Ctrl+,): theme (dark by default, light, or same as the system), font (Arial by default), text size (17 by default), line spacing (Automatic = compact on phones, normal on computers; or Tight / Compact / Normal / Relaxed / Spacious), and whether formatting characters (`**`, `__`, `[](…)`) appear while you edit a line (off by default; Ctrl+M toggles it). These are saved per device.
- Phone toolbar: zoom, outdent, indent, complete, move up, move down, **Aa** (colors, headings, text styles, links, tables), move to document, delete, undo, redo.
- Multi-line paste becomes separate items (indentation is kept)
- Undo/redo, export/import a JSON backup, export as indented text
- A touch toolbar on phones (indent, outdent, move, complete, collapse, zoom, undo, redo)
- Offline-first: everything is saved on the device first and synced to Dropbox when online

Keyboard shortcuts are listed in the app (☰ → Keyboard shortcuts).

## How sync works

In Dropbox (`Apps/<your app name>/`), the outline is split into one gzip-compressed file per document (`docs/<id>.json.gz`) plus `index.json.gz` for the sidebar (folders, document names and order). Default values are left out, so the files stay small. A small edit uploads only the file of the document it touched, typically a few KB even when the whole outline is several MB.

Each device keeps its own copy in IndexedDB, one record per document. For each Dropbox file it also keeps the last synced version (the "base") and that file's Dropbox revision.

When a device syncs:

1. It asks Dropbox which files changed since last time. When nothing has changed, this tiny listing is all that's transferred.
2. It downloads only the changed files.
3. It does a three-way merge over the whole outline, item by item and field by field.
4. It uploads only the files whose content changed, each only if the file hasn't changed again in the meantime; otherwise it starts over.

Moving a line between documents changes two files. In the rare case of a race, a line can appear twice (never zero times). When it does, the newer copy wins.
- Different items edited on two devices: both edits are kept.
- Same item, different fields (e.g. text on one device, completed on the other): both changes are kept.
- Same item's text edited on both devices: the newer edit wins, and the other text is kept as a sibling item marked "(conflict)". Nothing is lost.
- An item deleted on one device but edited on the other: the item is kept.

When sync runs:

- **Sending:** about 1 second after you stop typing, or at most 4 seconds into a long typing streak.
- **Receiving:** while the app is open, it holds a Dropbox change-notification request open (long-poll), so edits from another device arrive within a few seconds.
- **Other times:** when the app is opened or brought back to the foreground, when the device comes back online, and once a minute as a fallback.
- **On demand:** Ctrl+S, tapping the sync icon, or ☰ → Sync now.

**Daily backups:** after the first successful sync each day (on whichever device gets there first), the app saves a dated, compressed copy to `Apps/<app name>/backups/outline-YYYY-MM-DD.json.gz` and deletes copies older than the chosen number of days. The default is 30 days; Settings has Off, 7, 30, 90 and 365 days, and Keep all. ⋮ → **Back up now** makes or replaces today's copy. To restore, download a backup file from Dropbox and use ⋮ → **Import backup**. Backups only happen when the app is opened (web apps can't run in the background).

Most checks only ask Dropbox for the file's revision. The full file is downloaded only when another device has changed it. Dropbox also keeps 30 days of file history for `outline.json`.

## One-time setup

### 1. Create a Dropbox app (free, about 2 minutes)

1. Go to <https://www.dropbox.com/developers/apps> → **Create app**.
2. Choose **Scoped access** → **App folder**, and give it a unique name (e.g. `ron-outliner`).
3. On the **Permissions** tab, tick `files.content.write` and `files.content.read`, then click **Submit**.
4. On the **Settings** tab:
   - Copy the **App key** into `js/config.js` (`DROPBOX_APP_KEY = '...'`). The app key is not a secret.
   - Under **OAuth 2 → Redirect URIs**, add every address you'll run the app from, *exactly*, including the trailing slash:
     - `http://localhost:8000/` (local testing)
     - your hosted address, e.g. `https://<github-user>.github.io/outliner/`
   - Leave **Allow public clients (Implicit Grant & PKCE)** set to *Allow*.

### 2. Host it (HTTPS is required to install it on a phone)

Any static host works. Two easy options:

- **GitHub Pages:** push this folder to a repo, then go to Settings → Pages → *Deploy from branch*. It's served at `https://<user>.github.io/<repo>/`.
- **Netlify Drop / Cloudflare Pages:** drag and drop this folder in the browser.

Whatever address you use must also be listed as a Redirect URI in step 1.

### 3. Install

- **Android (Chrome):** open the hosted address → ⋮ menu → **Add to home screen** / **Install app**.
- **Windows (Edge or Chrome):** open the address → click the install icon in the address bar (or ⋯ → Apps → Install).

Then on each device: ☰ → **Connect Dropbox**. The first device uploads its outline. A brand-new device that hasn't been edited yet just downloads the existing one.

## Local development

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8000/>. Tests (key ordering, merge, formatting) run at <http://localhost:8000/tests/>.

`tools\make-icons.ps1` regenerates the PNG icons.

## Layout

| File | Purpose |
|---|---|
| `js/model.js` | Flat node map, fractional position keys, tree operations |
| `js/merge.js` | Three-way merge used by sync |
| `js/sync.js` | List changes → download changed files → merge → conditional upload |
| `js/shards.js` | Per-document split, compact JSON, gzip |
| `js/local.js`, `js/idb.js` | The outline on the device (IndexedDB) |
| `js/dropbox.js` | Dropbox PKCE sign-in, download/upload |
| `js/ui.js` | Rendering, editing, keyboard and toolbar commands |
| `js/format.js` | Inline formatting (keeps raw text = textContent) |
| `js/app.js` | Startup, menu, persistence, sync triggers |
| `sw.js` | Service worker for offline use |

`model`, `merge` and `sync` don't touch the DOM, so the same code could later be wrapped in a native shell (e.g. Tauri) if the PWA ever falls short.
