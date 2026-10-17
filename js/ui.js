// Outline editor: rendering, editing, keyboard and touch commands, sidebar.
//
// Each item's text is a contenteditable="plaintext-only" element whose
// textContent is always the raw item text (see format.js). Typing only updates
// the model; structural commands (split, indent, move...) mutate the model and
// re-render the visible tree, then restore focus and caret.
//
// The root's children are documents. The main view always shows a document or
// an item inside one (`zoom`); the sidebar lists the documents.

import { ROOT } from './model.js';
import { format, esc } from './format.js';
import { load, save } from './store.js';
import { Drag } from './drag.js';
import { tableMethods } from './table.js';
import { Menu } from './menu.js';

const $ = (sel, el = document) => el.querySelector(sel);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const narrow = () => matchMedia('(max-width: 800px)').matches;

export class UI {
  constructor(outline, { onChange, prefs }) {
    this.o = outline;
    this.onChange = onChange;
    this.prefs = prefs; // { showDone }
    this.zoom = null;
    this.query = '';
    this.undoStack = [];
    this.redoStack = [];
    this.focusId = null;

    this.main = $('#outline');
    this.crumbs = $('#crumbs');
    this.search = $('#search');
    this.toolbar = $('#toolbar');
    this.palette = $('#palette');
    this.docs = $('#docs');
    this.searchAllBtn = $('#search-all');
    this.tableTools = $('#table-tools');
    this.tableHead = $('#table-head');
    this.imgPop = $('#img-pop');
    this.moveDlg = $('#move');

    document.body.classList.toggle('side-hidden', !!load('sideHidden'));
    this.menu = new Menu();
    this.bind();
    this.drag = new Drag(this);
    this.zoomFromHash();
  }

  // ---------- rendering ----------

  // Make sure we're looking at something that exists inside a document.
  ensureZoom() {
    if (this.zoom && this.o.docOf(this.zoom)) return;
    let docs = this.o.allDocs();
    if (!docs.length) {
      const d = this.o.insert(ROOT, lastChildId(this.o, ROOT), { t: 'My outline' });
      this.o.insert(d.id, null, {});
      this.onChange();
      docs = this.o.allDocs();
    }
    const last = load('lastDoc');
    this.zoom = docs.some((d) => d.id === last) ? last : docs[0].id;
    history.replaceState(null, '', location.pathname + location.search + '#' + this.zoom);
  }

  render() {
    this.ensureZoom();
    const doc = this.o.docOf(this.zoom);
    if (doc.id !== load('lastDoc')) save('lastDoc', doc.id);
    this.searchAllBtn.setAttribute('aria-pressed', String(!!this.prefs.searchAll));
    if (this.query.trim() && this.prefs.searchAll) return this.renderSearchAll();
    const visible = this.visibleSet();
    const z = this.o.get(this.zoom);
    let html = `<div class="title text${z.d ? ' done' : ''}${colorClass(z)}" contenteditable="plaintext-only" spellcheck="true" data-id="${z.id}" data-placeholder="Untitled">${format(z.t)}</div>`;
    const kids = this.renderChildren(this.zoom, visible);
    html += kids
      ? `<div class="list">${kids}</div>`
      : this.query
        ? `<p class="empty">No matches.</p>`
        : // Nothing here yet: an empty first line that becomes real when focused.
          `<div class="list"><div class="item" data-item=""><div class="row"><span class="zoom"></span>` +
          `<span class="bullet"></span><div class="text" contenteditable="plaintext-only" spellcheck="true" data-id="" data-new="${this.zoom}|"></div></div></div></div>`;
    this.main.innerHTML = html;
    this.renderCrumbs();
    this.renderSidebar();
  }

  renderChildren(pid, visible) {
    let html = '';
    for (const n of this.o.children(pid)) {
      if (visible && !visible.has(n.id)) continue;
      if (!visible && n.d && !this.prefs.showDone) continue;
      html += this.renderNode(n, visible);
    }
    return html;
  }

  renderNode(n, visible) {
    if (n.tb) {
      const open = !n.c || !!visible;
      return (
        `<div class="item table-item${n.d ? ' done' : ''}" data-item="${n.id}">` +
        `<div class="row${n.h ? ` h${n.h}` : ''}">` +
        marker(true, open) +
        `<div class="text${colorClass(n)}" contenteditable="plaintext-only" spellcheck="true" data-id="${n.id}" data-placeholder="Table">${format(n.t)}</div>` +
        `</div>` + (open ? this.renderTable(n) : '') + `</div>`
      );
    }
    const kids = this.o.children(n.id).filter((k) => (visible ? visible.has(k.id) : this.prefs.showDone || !k.d));
    const has = kids.length > 0;
    const open = has && (!n.c || !!visible);
    const inner = open ? this.renderChildren(n.id, visible) : '';
    return (
      `<div class="item${n.d ? ' done' : ''}" data-item="${n.id}">` +
      `<div class="row${n.h ? ` h${n.h}` : ''}">` +
      marker(has, open) +
      `<div class="text${colorClass(n)}" contenteditable="plaintext-only" spellcheck="true" data-id="${n.id}">${format(n.t)}</div>` +
      `</div>` +
      (inner ? `<div class="children">${inner}</div>` : '') +
      `</div>`
    );
  }

  renderCrumbs() {
    const anc = this.o.ancestors(this.zoom).filter((a) => a.id !== ROOT && !a.f);
    this.crumbs.innerHTML = anc
      .map((a) => `<a href="#${a.id}" data-zoom="${a.id}">${esc(trim(a.t) || 'Untitled')}</a>`)
      .join('<span class="sep">›</span>');
  }

  renderSidebar() {
    const cur = this.o.docOf(this.zoom)?.id;
    const btn = (cls, title, label) =>
      `<button class="${cls}" type="button" title="${title}" aria-label="${title}">${label}</button>`;
    const tree = (pid, depth) =>
      this.o.children(pid).map((n) => {
        if (n.f) {
          const open = !n.c;
          return (
            `<div class="entry folder${open ? ' open' : ''}" data-doc="${n.id}" style="--d:${depth}">` +
            `<span class="twisty"></span>${open ? ICON_FOLDER_OPEN : ICON_FOLDER}<span class="name">${esc(n.t || 'Untitled folder')}</span>` +
            `<span class="acts">${btn('more', 'Folder actions', '⋯')}</span></div>` + (open ? tree(n.id, depth + 1) : '')
          );
        }
        return (
          `<div class="entry doc${n.id === cur ? ' active' : ''}" data-doc="${n.id}" style="--d:${depth}">` +
          `${ICON_DOC}<span class="name">${esc(n.t || 'Untitled')}</span>` +
          `<span class="acts">${btn('more', 'Document actions', '⋯')}</span>` +
          `</div>`
        );
      }).join('');
    this.docs.innerHTML = tree(ROOT, 0);
  }

  // Search results across every document, grouped under document headings.
  renderSearchAll() {
    const terms = this.terms();
    const set = new Set();
    const hitDocs = new Set();
    for (const n of Object.values(this.o.nodes)) {
      if (n.id === ROOT || n.f || (n.d && !this.prefs.showDone) || !matches(n.t, terms)) continue;
      const doc = this.o.docOf(n.id);
      if (!doc) continue;
      hitDocs.add(doc.id);
      for (let x = n; x && x.id !== doc.id && !set.has(x.id); x = this.o.get(x.p)) set.add(x.id);
    }
    let html = '';
    for (const d of this.o.allDocs()) {
      if (!hitDocs.has(d.id)) continue;
      html += `<div class="result-doc"><a href="#${d.id}" data-open="${d.id}">${esc(d.t || 'Untitled')}</a></div>`;
      const kids = this.renderChildren(d.id, set);
      if (kids) html += `<div class="list">${kids}</div>`;
    }
    this.main.innerHTML = html || `<p class="empty">No matches in any document.</p>`;
    this.crumbs.textContent = 'Searching all documents';
    this.renderSidebar();
  }

  terms() { return this.query.toLowerCase().split(/\s+/).filter(Boolean); }

  // With a search query: the set of matching nodes plus their ancestors (up to
  // the zoom root). Without one: null (show everything).
  visibleSet() {
    const terms = this.terms();
    if (!terms.length) return null;
    const set = new Set();
    for (const n of Object.values(this.o.nodes)) {
      if (n.id === ROOT || n.id === this.zoom) continue;
      if (n.d && !this.prefs.showDone) continue;
      if (!matches(n.t, terms)) continue;
      if (!this.o.isAncestor(this.zoom, n.id)) continue;
      for (let x = n; x && x.id !== this.zoom && !set.has(x.id); x = this.o.get(x.p)) set.add(x.id);
    }
    return set;
  }

  // Re-render keeping focus and caret (used after sync brings in changes).
  refresh() {
    const el = document.activeElement;
    const id = el && el.classList.contains('text') ? el.dataset.id : null;
    const off = id ? getCaret(el) : null;
    this.render();
    if (id && this.o.get(id)) this.focus(id, off ?? 'end');
  }

  // ---------- focus & caret ----------

  textEl(id) { return this.main.querySelector(`.text[data-id="${id}"]`); }

  // Focus an item with the caret at `offset`, or select offset..end.
  focus(id, offset = 'end', end = null) {
    const el = this.textEl(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    const start = offset === 'end' ? el.textContent.length : offset;
    if (end !== null && end !== start) setSelectionRange(el, start, end);
    else setCaret(el, start);
    el.scrollIntoView({ block: 'nearest' });
  }

  visibleIds() { return [...this.main.querySelectorAll('.text')].map((e) => e.dataset.id); }

  // ---------- undo ----------

  checkpoint(kind = 'op', id = null) {
    const top = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (kind === 'text' && top && top.kind === 'text' && top.id === id && now - top.time < 2000) {
      top.time = now;
      return;
    }
    this.undoStack.push({ nodes: this.o.snapshot(), focus: this.currentFocus(), zoom: this.zoom, kind, id, time: now });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  currentFocus() {
    const el = document.activeElement;
    return el && el.classList.contains('text') ? { id: el.dataset.id, off: getCaret(el) } : null;
  }

  undo(redo = false) {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const rec = from.pop();
    if (!rec) return;
    to.push({ nodes: this.o.snapshot(), focus: this.currentFocus(), zoom: this.zoom, kind: 'op', time: 0 });
    this.o.restore(rec.nodes);
    if (rec.zoom && rec.zoom !== this.zoom && this.o.get(rec.zoom)) this.go(rec.zoom);
    else this.render();
    if (rec.focus && this.o.get(rec.focus.id)) this.focus(rec.focus.id, rec.focus.off ?? 'end');
    this.onChange();
  }

  // ---------- commands ----------

  // Run a structural change with an undo checkpoint, then re-render and focus.
  op(fn) {
    this.checkpoint();
    const f = fn();
    if (f === false) {
      this.undoStack.pop();
      return;
    }
    this.render();
    if (f) this.focus(f.id, f.off, f.end ?? null);
    this.onChange();
  }

  split(id, off) {
    this.op(() => {
      const n = this.o.get(id);
      const before = n.t.slice(0, off), after = n.t.slice(off);
      if (id === this.zoom) {
        this.o.update(id, { t: before });
        const c = this.o.insert(id, null, { t: after });
        return { id: c.id, off: 0 };
      }
      if (off === 0 && n.t.length > 0) {
        const prev = this.o.prevSibling(id);
        this.o.insert(n.p, prev ? prev.id : null, {});
        return { id, off: 0 };
      }
      this.o.update(id, { t: before });
      const kids = this.o.children(id).filter((k) => this.prefs.showDone || !k.d);
      const c = kids.length && !n.c ? this.o.insert(id, null, { t: after }) : this.o.insert(n.p, id, { t: after });
      return { id: c.id, off: 0 };
    });
  }

  // Backspace at the start of an item. Returns true if handled.
  backspace(id) {
    if (id === this.zoom) return false;
    if (this.o.isCell(id)) return true; // cells never merge
    const n = this.o.get(id);
    const ids = this.visibleIds();
    const i = ids.indexOf(id);
    const prevId = i > 0 ? ids[i - 1] : null;
    const hasKids = this.o.hasChildren(id);
    if (!n.t && !hasKids) {
      const nextId = ids[i + 1];
      this.op(() => {
        this.o.remove(id);
        return prevId ? { id: prevId, off: 'end' } : nextId ? { id: nextId, off: 0 } : null;
      });
      return true;
    }
    if (!prevId || prevId === this.zoom) return true;
    // In all-documents search the item above may belong to another document;
    // and an item right below a table must not merge into a cell.
    if (this.o.docOf(prevId) !== this.o.docOf(id) || this.o.isDoc(prevId) || this.o.isCell(prevId)) return true;
    const prev = this.o.get(prevId);
    if (hasKids && (this.o.prevSibling(id)?.id !== prevId || this.o.hasChildren(prevId))) return true;
    this.op(() => {
      const joint = prev.t.length;
      this.o.update(prevId, { t: prev.t + n.t });
      let after = null;
      for (const k of this.o.children(id)) {
        this.o.move(k.id, prevId, after);
        after = k.id;
      }
      this.o.remove(id);
      return { id: prevId, off: joint };
    });
    return true;
  }

  indent(id) {
    if (id === this.zoom || this.o.isCell(id)) return;
    const off = this.caretOf(id);
    this.op(() => {
      const prev = this.o.prevSibling(id);
      if (!prev || prev.tb) return false;
      this.o.move(id, prev.id, lastChildId(this.o, prev.id));
      if (prev.c) this.o.update(prev.id, { c: false });
      return { id, off };
    });
  }

  outdent(id) {
    const n = this.o.get(id);
    // Never outdent out of the zoomed item or out of a document.
    if (id === this.zoom || n.p === this.zoom || this.o.isDoc(n.p) || this.o.isCell(id)) return;
    const off = this.caretOf(id);
    this.op(() => {
      const parent = this.o.get(n.p);
      this.o.move(id, parent.p, parent.id);
      return { id, off };
    });
  }

  moveUp(id) {
    if (id === this.zoom || this.o.isCell(id)) return;
    const off = this.caretOf(id);
    this.op(() => {
      const n = this.o.get(id);
      const prev = this.o.prevSibling(id);
      if (!prev) return false;
      const before = this.o.prevSibling(prev.id);
      this.o.move(id, n.p, before ? before.id : null);
      return { id, off };
    });
  }

  moveDown(id) {
    if (id === this.zoom || this.o.isCell(id)) return;
    const off = this.caretOf(id);
    this.op(() => {
      const n = this.o.get(id);
      const next = this.o.nextSibling(id);
      if (!next) return false;
      this.o.move(id, n.p, next.id);
      return { id, off };
    });
  }

  toggleDone(id) {
    if (this.o.isCell(id)) return;
    const off = this.caretOf(id);
    const ids = this.visibleIds();
    this.op(() => {
      const n = this.o.get(id);
      this.o.update(id, { d: !n.d });
      if (n.d && !this.prefs.showDone && id !== this.zoom) {
        // It is about to disappear; move focus to a neighbour.
        const i = ids.indexOf(id);
        const nb = ids.slice(i + 1).find((x) => !this.o.isAncestor(id, x)) || ids[i - 1];
        return nb ? { id: nb, off: 'end' } : null;
      }
      return { id, off };
    });
  }

  // Color label 1-6; choosing the current color again (or 0) removes it.
  setColor(id, c) {
    const off = this.caretOf(id);
    this.op(() => {
      const cur = this.o.get(id).cl || 0;
      const next = c === cur ? 0 : c;
      if (next === cur) return false;
      this.o.update(id, { cl: next });
      return document.activeElement?.dataset?.id === id || off !== 'end' ? { id, off } : null;
    });
  }

  // Heading level 1-3; choosing the current level again (or 0) removes it.
  setHeading(id, h) {
    if (id === this.zoom || this.o.isCell(id)) return;
    const off = this.caretOf(id);
    this.op(() => {
      const cur = this.o.get(id).h || 0;
      const next = h === cur ? 0 : h;
      if (next === cur) return false;
      this.o.update(id, { h: next });
      return { id, off };
    });
  }

  // Selection inside the item being edited, as [start, end] offsets.
  selection(id) {
    const el = this.textEl(id);
    const sel = getSelection();
    if (!el || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      const len = this.o.get(id).t.length;
      return [len, len];
    }
    const at = (node, off) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(node, off);
      return r.toString().length;
    };
    const a = at(sel.anchorNode, sel.anchorOffset), b = at(sel.focusNode, sel.focusOffset);
    return [Math.min(a, b), Math.max(a, b)];
  }

  // Wrap the selection in a style marker (**, __, ~~, ==), or remove that
  // style if the selection already has it. Styles stack: Ctrl+B then Ctrl+I
  // on the same word gives **__word__**, and the word stays selected so the
  // next shortcut applies to it too.
  wrap(id, mark) {
    const [s, e] = this.selection(id);
    this.op(() => {
      const t = this.o.get(id).t;
      // Markers directly around the selection, innermost first.
      const left = [], right = [];
      for (let i = s; i >= 2 && STYLE_MARKS.includes(t.slice(i - 2, i)); i -= 2) left.push(i - 2);
      for (let j = e; STYLE_MARKS.includes(t.slice(j, j + 2)); j += 2) right.push(j);
      for (let k = 0; k < Math.min(left.length, right.length); k++) {
        if (t.slice(left[k], left[k] + 2) === mark && t.slice(right[k], right[k] + 2) === mark) {
          const a = left[k], b = right[k];
          this.o.update(id, { t: t.slice(0, a) + t.slice(a + 2, b) + t.slice(b + 2) });
          return { id, off: s - 2, end: e - 2 };
        }
      }
      this.o.update(id, { t: t.slice(0, s) + mark + t.slice(s, e) + mark + t.slice(e) });
      return { id, off: s + 2, end: e + 2 };
    });
  }

  // Insert a [text](url) link, using the selected text as the link text.
  insertLink(id) {
    const [s, e] = this.selection(id);
    const t = this.o.get(id).t;
    const selected = t.slice(s, e);
    const looksLikeUrl = /^(https?:\/\/|www\.)\S+$/i.test(selected);
    const url = prompt('Link address:', looksLikeUrl ? selected : 'https://');
    if (!url || url === 'https://') return this.focus(id, e);
    let label = looksLikeUrl ? '' : selected;
    if (!label) label = prompt('Link text (optional):', '') || '';
    const link = label ? `[${label}](${url.trim()})` : url.trim();
    this.op(() => {
      this.o.update(id, { t: t.slice(0, s) + link + t.slice(e) });
      return { id, off: s + link.length };
    });
  }

  setCollapsed(id, c) {
    const n = this.o.get(id);
    if (!n || n.c === c || !this.o.hasChildren(id) || id === this.zoom) return;
    const off = this.caretOf(id);
    this.op(() => {
      this.o.update(id, { c });
      return document.activeElement?.dataset?.id === id ? { id, off } : null;
    });
  }

  // Ctrl+Shift+Backspace: delete the item and everything under it (in a
  // table cell: delete that row).
  deleteItem(id) {
    if (id === this.zoom) return;
    if (this.o.isCell(id)) return this.delRow(id);
    const els = [...this.main.querySelectorAll('.text')];
    const mine = (el) => el.dataset.id === id || this.o.isAncestor(id, el.dataset.id);
    const i = els.findIndex(mine);
    const next = els.slice(i).find((el) => !mine(el) && el.dataset.id);
    const prev = els.slice(0, i).reverse().find((el) => el.dataset.id);
    const target = prev && prev.dataset.id !== this.zoom ? prev : next || prev;
    this.op(() => {
      this.o.remove(id);
      return target ? { id: target.dataset.id, off: target === next ? 0 : 'end' } : null;
    });
  }

  // ---------- move to another document (Ctrl+Shift+M) ----------

  openMove(id) {
    if (!id || id === this.zoom || this.o.isCell(id) || this.o.isRow(id)) return;
    this.moveId = id;
    const input = this.moveDlg.querySelector('input');
    input.value = '';
    this.renderMoveList();
    this.moveDlg.showModal();
    input.focus();
  }

  renderMoveList() {
    const q = this.moveDlg.querySelector('input').value.toLowerCase();
    const here = this.o.docOf(this.moveId)?.id;
    const path = (d) => this.o.ancestors(d.id).filter((a) => a.f).map((a) => a.t || 'Untitled folder');
    const docs = this.o.allDocs().filter((d) => (d.t || 'Untitled').toLowerCase().includes(q));
    this.moveDlg.querySelector('ul').innerHTML = docs
      .map((d, i) => {
        const p = path(d);
        return `<li data-doc="${d.id}" class="${i === 0 ? 'sel' : ''}">${ICON_DOC}<span>${esc(d.t || 'Untitled')}</span>` +
          (p.length ? `<small>${esc(p.join(' / '))}</small>` : '') + (d.id === here ? '<small>(current)</small>' : '') + `</li>`;
      })
      .join('') || '<li class="none">No matching documents</li>';
  }

  moveTo(docId) {
    const id = this.moveId;
    this.moveDlg.close();
    if (!docId || !this.o.get(id)) return;
    const els = [...this.main.querySelectorAll('.text')];
    const mine = (el) => el.dataset.id === id || this.o.isAncestor(id, el.dataset.id);
    const i = els.findIndex(mine);
    const nb = els.slice(i).find((el) => !mine(el) && el.dataset.id) || els.slice(0, i).reverse().find((el) => el.dataset.id);
    const name = this.o.get(docId).t || 'Untitled';
    this.op(() => {
      if (!this.placeItem(id, docId, 'child')) return false; // top of the document
      return nb && this.o.get(nb.dataset.id) && this.textEl(nb.dataset.id) !== null ? { id: nb.dataset.id, off: 'end' } : null;
    });
    this.toast(`Moved to “${name}”`);
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  // ---------- image preview for !-links ----------

  showImage(link) {
    const pop = this.imgPop;
    const img = pop.querySelector('img');
    if (img.getAttribute('src') !== link.dataset.href) img.src = link.dataset.href;
    pop.dataset.href = link.dataset.href;
    pop.hidden = false;
    const r = link.getBoundingClientRect();
    const w = Math.min(420, innerWidth - 16);
    pop.style.maxWidth = `${w}px`;
    pop.style.left = `${Math.min(Math.max(r.left, 8), innerWidth - w - 8)}px`;
    const below = innerHeight - r.bottom > 240 || r.top < 240;
    pop.style.top = below ? `${r.bottom + 6}px` : '';
    pop.style.bottom = below ? '' : `${innerHeight - r.top + 6}px`;
  }

  hideImage() { this.imgPop.hidden = true; }

  addItem() {
    this.op(() => {
      const c = this.o.insert(this.zoom, lastChildId(this.o, this.zoom), {});
      return { id: c.id, off: 0 };
    });
  }

  // Paste multi-line text as items; indentation (tabs / 2+ spaces) nests.
  pasteLines(id, off, text) {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return;
    this.op(() => {
      const n = this.o.get(id);
      const parse = (l) => {
        const m = /^(\s*)(?:[-*•]\s+|\d+[.)]\s+)?(.*)$/.exec(l.replace(/\t/g, '  '));
        return { depth: Math.floor(m[1].length / 2), t: m[2] };
      };
      const items = lines.map(parse);
      const base = Math.min(...items.map((x) => x.depth));
      const rest = n.t.slice(off);
      this.o.update(id, { t: n.t.slice(0, off) + items[0].t });
      // Pasting into the title puts the remaining lines at the top of the
      // list; otherwise they follow the item as siblings.
      const isTitle = id === this.zoom;
      const p0 = isTitle ? id : n.p;
      let after0 = isTitle ? null : id;
      const stack = isTitle ? [] : [n]; // stack[d] = last node at relative depth d
      let last = n;
      for (const it of items.slice(1)) {
        const d = Math.min(Math.max(it.depth - base, 0), stack.length);
        let node;
        if (d === 0) {
          node = this.o.insert(p0, after0, { t: it.t });
          after0 = node.id;
        } else {
          node = this.o.insert(stack[d - 1].id, lastChildId(this.o, stack[d - 1].id), { t: it.t });
        }
        stack[d] = node;
        stack.length = d + 1;
        last = node;
      }
      if (rest) this.o.update(last.id, { t: last.t + rest });
      return { id: last.id, off: last.t.length - rest.length };
    });
  }

  // ---------- moving (drag and drop) ----------

  // Move src to just before / after target among target's siblings, or into
  // target as its first child. Returns false if not allowed.
  placeItem(src, targetId, where) {
    const t = this.o.get(targetId);
    if (!t || src === targetId || this.o.isAncestor(src, targetId)) return false;
    if (this.o.isRow(targetId) || this.o.isCell(targetId)) return false;
    if (where === 'child') {
      if (t.tb || !this.o.move(src, targetId, null)) return false;
      if (t.c) this.o.update(targetId, { c: false });
      return true;
    }
    if (where === 'into') {
      // Last child (dropping onto a document or folder in the sidebar).
      const kids = this.o.children(targetId).filter((k) => k.id !== src);
      if (!this.o.move(src, targetId, kids.length ? kids[kids.length - 1].id : null)) return false;
      if (t.f && t.c) this.o.update(targetId, { c: false });
      return true;
    }
    if (where === 'after') return this.o.move(src, t.p, targetId);
    const sibs = this.o.children(t.p).filter((s) => s.id !== src);
    const i = sibs.indexOf(t);
    return this.o.move(src, t.p, i > 0 ? sibs[i - 1].id : null);
  }

  drop(src, targetId, where) {
    this.op(() => (this.placeItem(src, targetId, where) ? null : false));
  }

  // ---------- documents ----------

  go(id) {
    const hash = '#' + id;
    if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
    this.zoomFromHash();
  }

  zoomTo(id) { this.go(id); }

  zoomFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    this.zoom = id && this.o.get(id) ? id : null;
    this.render();
    window.scrollTo(0, 0);
    // An empty document: put the cursor on its first (placeholder) line.
    if (!this.query && this.o.isDoc(this.zoom) && !this.o.hasChildren(this.zoom)) {
      this.main.querySelector('.text[data-new]')?.focus();
    }
  }

  // A placeholder line (empty doc, or a missing table cell) becomes a real
  // node the moment it gets focus.
  materialize(el) {
    const [p, after] = el.dataset.new.split('|');
    if (!this.o.get(p)) return;
    const n = this.o.insert(p, after && this.o.get(after) ? after : null, {});
    el.dataset.id = n.id;
    delete el.dataset.new;
    const item = el.closest('.item');
    if (item && item.dataset.item === '') item.dataset.item = n.id;
    this.onChange();
  }

  openDoc(id) {
    if (this.query) this.setQuery('');
    this.go(id);
    document.body.classList.remove('side-open');
  }

  // New document next to the current one (same folder), or inside `folderId`.
  newDoc(folderId = null) {
    this.checkpoint();
    let d;
    if (folderId) {
      d = this.o.insert(folderId, lastChildId(this.o, folderId), { t: '' });
      if (this.o.get(folderId).c) this.o.update(folderId, { c: false });
    } else {
      const cur = this.o.docOf(this.zoom);
      d = cur ? this.o.insert(cur.p, cur.id, { t: '' }) : this.o.insert(ROOT, lastChildId(this.o, ROOT), { t: '' });
    }
    this.o.insert(d.id, null, {});
    this.onChange();
    this.openDoc(d.id);
    this.focus(d.id, 0);
  }

  newFolder(parentId = ROOT) {
    const name = prompt('Folder name:', '');
    if (name === null) return;
    this.checkpoint();
    this.o.insert(parentId, lastChildId(this.o, parentId), { t: name.trim() || 'New folder', f: true });
    if (parentId !== ROOT && this.o.get(parentId).c) this.o.update(parentId, { c: false });
    this.onChange();
    this.renderSidebar();
  }

  // Copy a document, folder or item (with everything under it) right after
  // the original, under the same name.
  duplicate(id) {
    const n = this.o.get(id);
    if (!n || n.id === ROOT || this.o.isCell(id) || this.o.isRow(id)) return;
    if (this.o.isDoc(id) || n.f) {
      this.checkpoint();
      this.o.copySubtree(id, n.p, id);
      this.onChange();
      this.render();
      this.toast(`Duplicated “${n.t || 'Untitled'}”`);
      return;
    }
    this.op(() => {
      const c = this.o.copySubtree(id, n.p, id);
      return { id: c.id, off: 'end' };
    });
  }

  // ---------- menus ----------

  openEntryMenu(id, x, y) {
    const n = this.o.get(id);
    if (!n) return;
    const items = n.f
      ? [
          { label: 'New document here', run: () => this.newDoc(id) },
          { label: 'New subfolder…', run: () => this.newFolder(id) },
          'sep',
          { label: 'Rename…', run: () => this.renameEntry(id) },
          { label: 'Duplicate', run: () => this.duplicate(id) },
          'sep',
          { label: 'Delete folder…', danger: true, run: () => this.deleteEntry(id) },
        ]
      : [
          { label: 'Open', run: () => this.openDoc(id) },
          { label: 'Rename…', run: () => this.renameEntry(id) },
          { label: 'Duplicate', run: () => this.duplicate(id) },
          { label: 'Export as OPML', run: () => this.onExportOPML?.(id) },
          'sep',
          { label: 'Delete document…', danger: true, run: () => this.deleteEntry(id) },
        ];
    this.menu.lastKey = id;
    this.menu.open(items, x, y);
  }

  openItemMenu(id, x, y) {
    const n = this.o.get(id);
    if (!n) return;
    const items = [
      { label: 'Zoom in', hint: 'Alt+→', run: () => this.zoomTo(id) },
      { label: n.d ? 'Mark not complete' : 'Mark complete', hint: 'Ctrl+Enter', run: () => this.toggleDone(id) },
      { label: n.c ? 'Expand' : 'Collapse', hint: 'Ctrl+.', run: () => this.setCollapsed(id, !n.c) },
      'sep',
      { swatches: [1, 2, 3, 4, 5, 6, 0], run: (c) => this.setColor(id, c) },
      { buttons: [
          { label: 'H1', value: 1, title: 'Heading 1' }, { label: 'H2', value: 2, title: 'Heading 2' },
          { label: 'H3', value: 3, title: 'Heading 3' }, { label: '¶', value: 0, title: 'Normal text' },
        ], run: (h) => this.setHeading(id, h) },
      'sep',
      { label: 'Duplicate', run: () => this.duplicate(id) },
      { label: 'Move to document…', hint: 'Ctrl+Shift+M', run: () => this.openMove(id) },
      'sep',
      n.tb
        ? { label: 'Delete table', danger: true, run: () => this.deleteTable(id) }
        : { label: 'Delete', hint: 'Ctrl+Shift+⌫', danger: true, run: () => this.deleteItem(id) },
    ];
    if (!this.o.hasChildren(id)) items.splice(2, 1); // nothing to collapse
    this.menu.lastKey = id;
    this.menu.open(items, x, y);
  }

  renameEntry(id) {
    const n = this.o.get(id);
    const name = prompt(n.f ? 'Rename folder:' : 'Rename document:', n.t);
    if (name === null || name === n.t) return;
    this.checkpoint();
    this.o.update(id, { t: name });
    this.onChange();
    this.render();
  }

  // Delete a document or a folder (with everything in it). Undoable.
  deleteEntry(id) {
    const n = this.o.get(id);
    let msg;
    if (n.f) {
      const count = this.o.allDocs(id).length;
      msg = `Delete the folder "${n.t || 'Untitled folder'}"` + (count ? ` and the ${count} document${count > 1 ? 's' : ''} in it?` : '?');
    } else {
      msg = `Delete the document "${n.t || 'Untitled'}" and everything in it?`;
    }
    if (!confirm(`${msg}\n\n(Ctrl+Z / Undo brings it back.)`)) return;
    this.checkpoint();
    this.o.remove(id);
    this.onChange();
    if (!this.o.get(this.zoom)) {
      this.zoom = null;
      save('lastDoc', null);
    }
    this.render();
  }

  toggleFolder(id) {
    this.o.update(id, { c: !this.o.get(id).c });
    this.onChange();
    this.renderSidebar();
  }

  setSearchAll(on) {
    this.prefs.searchAll = on;
    save('prefs', this.prefs);
    this.render();
    this.search.focus();
  }

  toggleSidebar() {
    if (narrow()) {
      document.body.classList.toggle('side-open');
    } else {
      const hidden = document.body.classList.toggle('side-hidden');
      save('sideHidden', hidden || null);
    }
  }

  setQuery(q) {
    this.query = q;
    if (this.search.value !== q) this.search.value = q;
    this.render();
  }

  caretOf(id) {
    const el = this.textEl(id);
    return el && document.activeElement === el ? getCaret(el) ?? 'end' : 'end';
  }

  // ---------- events ----------

  bind() {
    const m = this.main;
    this.bindTableResize();

    m.addEventListener('click', (e) => {
      const t = e.target;
      const open = t.closest('[data-open]');
      if (open) {
        e.preventDefault();
        return this.openDoc(open.dataset.open);
      }
      const row = t.closest('.row');
      const id = row && row.closest('.item').dataset.item;
      if (!id) return;
      if (t.closest('.zoom')) {
        this.zoomTo(id);
      } else if (t.classList.contains('bullet') && t.classList.contains('kids')) {
        this.setCollapsed(id, !this.o.get(id).c); // triangle: collapse / expand
      }
    });

    // Links open on tap when not editing that item (or with Ctrl/Cmd).
    // Image links (!…) on touch screens show the preview first instead.
    m.addEventListener('pointerdown', (e) => {
      const link = e.target.closest('.link');
      if (!link || (this.isEditing(link) && !e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      if (link.classList.contains('img') && e.pointerType !== 'mouse') {
        if (this.imgPop.hidden || this.imgPop.dataset.href !== link.dataset.href) this.showImage(link);
        else this.hideImage();
        return;
      }
      window.open(link.dataset.href, '_blank', 'noopener');
    });
    m.addEventListener('mouseover', (e) => {
      const link = e.target.closest('.link.img');
      if (link) this.showImage(link);
    });
    m.addEventListener('mouseout', (e) => {
      const link = e.target.closest('.link.img');
      if (link && !link.contains(e.relatedTarget)) this.hideImage();
    });
    this.imgPop.addEventListener('click', () => {
      window.open(this.imgPop.dataset.href, '_blank', 'noopener');
      this.hideImage();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.imgPop.hidden && !e.target.closest('#img-pop, .link.img')) this.hideImage();
    });
    window.addEventListener('scroll', () => this.hideImage(), { passive: true });

    m.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el.classList.contains('text')) return;
      if (el.dataset.new !== undefined) this.materialize(el);
      this.focusId = el.dataset.id;
      document.body.classList.add('editing');
      if (el.classList.contains('cell')) this.showTableTools(el);
      else this.tableTools.hidden = true;
    });

    m.addEventListener('focusout', (e) => {
      const el = e.target;
      if (!el.classList.contains('text')) return;
      const n = this.o.get(el.dataset.id);
      if (n && el.isConnected) el.innerHTML = format(n.t);
      setTimeout(() => {
        const a = document.activeElement;
        if (!a?.classList?.contains('text')) {
          document.body.classList.remove('editing');
          this.palette.hidden = true;
        }
        if (!a?.classList?.contains('cell')) {
          this.tableTools.hidden = true;
          this.unpinHeader();
        }
      }, 0);
    });

    m.addEventListener('beforeinput', (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains('text')) return;
      if (el.dataset.new !== undefined) this.materialize(el);
      const id = el.dataset.id;
      switch (e.inputType) {
        case 'insertParagraph':
        case 'insertLineBreak': {
          e.preventDefault();
          if (this.o.isCell(id)) return this.cellEnter(id);
          const off = getCaret(el);
          const sel = getSelection();
          if (!sel.isCollapsed) sel.deleteFromDocument();
          this.syncText(el);
          this.split(id, Math.min(off ?? el.textContent.length, el.textContent.length));
          return;
        }
        case 'deleteContentBackward': {
          if (getSelection().isCollapsed && getCaret(el) === 0) {
            if (this.backspace(id)) e.preventDefault();
            return;
          }
          break;
        }
        case 'historyUndo': e.preventDefault(); return this.undo();
        case 'historyRedo': e.preventDefault(); return this.undo(true);
      }
      this.checkpoint('text', id);
    });

    m.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.classList.contains('text')) return;
      if (el.dataset.new !== undefined) this.materialize(el);
      this.syncText(el);
    });

    m.addEventListener('paste', (e) => {
      const el = e.target.closest && e.target.closest('.text');
      if (!el) return;
      if (el.dataset.new !== undefined) this.materialize(el);
      const text = e.clipboardData.getData('text/plain');
      if (!text.includes('\n')) return;
      e.preventDefault();
      if (el.classList.contains('cell')) {
        // A cell is one line: join pasted lines with spaces.
        document.execCommand('insertText', false, text.replace(/\s*\r?\n\s*/g, ' ').trim());
        return;
      }
      const sel = getSelection();
      if (!sel.isCollapsed) sel.deleteFromDocument();
      this.syncText(el);
      this.pasteLines(el.dataset.id, getCaret(el) ?? el.textContent.length, text);
    });

    m.addEventListener('keydown', (e) => this.onKey(e));

    document.addEventListener('keydown', (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        e.preventDefault();
        this.search.focus();
        this.search.select();
      } else if (mod && !e.target.closest?.('.text, input') && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undo(e.shiftKey);
      }
    });

    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.render();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setQuery('');
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        const first = this.main.querySelector('.list .text');
        if (first) this.focus(first.dataset.id, 'end');
      }
    });

    this.crumbs.addEventListener('click', (e) => {
      const a = e.target.closest('[data-zoom]');
      if (!a) return;
      e.preventDefault();
      this.zoomTo(a.dataset.zoom);
    });

    window.addEventListener('popstate', () => this.zoomFromHash());

    // Sidebar
    $('#side-btn').addEventListener('click', () => this.toggleSidebar());
    $('#scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
    $('#new-doc').addEventListener('click', () => this.newDoc());
    $('#new-folder').addEventListener('click', () => this.newFolder());
    this.docs.addEventListener('click', (e) => {
      if (this.drag.justDropped()) return;
      const entry = e.target.closest('.entry');
      if (!entry) return;
      const id = entry.dataset.doc;
      const more = e.target.closest('.more');
      if (more) {
        // A second click on the same ⋯ closes the menu instead of reopening it.
        if (this.menu.lastKey === id && Date.now() - this.menu.closedAt < 300) return;
        const r = more.getBoundingClientRect();
        return this.openEntryMenu(id, r.left, r.bottom + 2);
      }
      if (this.o.get(id).f) return this.toggleFolder(id);
      this.openDoc(id);
    });
    // Right-click on a document/folder or on an item's bullet: our menu.
    // (Right-click in text keeps the browser's menu for spelling and paste.)
    this.docs.addEventListener('contextmenu', (e) => {
      const entry = e.target.closest('.entry');
      if (!entry) return;
      e.preventDefault();
      this.openEntryMenu(entry.dataset.doc, e.clientX, e.clientY);
    });
    m.addEventListener('contextmenu', (e) => {
      const bullet = e.target.closest('.bullet');
      const id = bullet?.closest('.item')?.dataset.item;
      if (!id) return;
      e.preventDefault();
      this.openItemMenu(id, e.clientX, e.clientY);
    });
    this.searchAllBtn.addEventListener('click', () => this.setSearchAll(!this.prefs.searchAll));

    // Touch toolbar. Preventing pointerdown/mousedown keeps focus (and the
    // soft keyboard) on the item being edited.
    const keep = (e) => { if (e.target.closest('button')) e.preventDefault(); };
    for (const el of [this.toolbar, this.palette, this.tableTools]) {
      el.addEventListener('pointerdown', keep);
      el.addEventListener('mousedown', keep);
    }
    this.tableTools.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tcmd]');
      const id = document.activeElement?.dataset?.id || this.focusId;
      if (b) this.tableCommand(b.dataset.tcmd, id);
    });

    // Move-to-document dialog
    const moveInput = this.moveDlg.querySelector('input');
    const moveList = this.moveDlg.querySelector('ul');
    moveInput.addEventListener('input', () => this.renderMoveList());
    moveInput.addEventListener('keydown', (e) => {
      const items = [...moveList.querySelectorAll('li[data-doc]')];
      let i = items.findIndex((li) => li.classList.contains('sel'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((li, j) => li.classList.toggle('sel', j === i));
        items[i]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[i]) this.moveTo(items[i].dataset.doc);
      }
    });
    moveList.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-doc]');
      if (li) this.moveTo(li.dataset.doc);
    });
    this.moveDlg.addEventListener('close', () => {
      if (this.moveId && this.o.get(this.moveId) && this.textEl(this.moveId)) this.focus(this.moveId);
      this.moveId = null;
    });
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      const id = document.activeElement?.dataset?.id || this.focusId;
      this.command(b.dataset.cmd, id);
    });
    this.palette.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = document.activeElement?.dataset?.id || this.focusId;
      this.palette.hidden = true;
      if (!id || !this.o.get(id)) return;
      if (b.dataset.color) return this.setColor(id, Number(b.dataset.color));
      switch (b.dataset.fmt) {
        case 'h1': case 'h2': case 'h3': return this.setHeading(id, Number(b.dataset.fmt[1]));
        case 'h0': return this.setHeading(id, 0);
        case 'bold': return this.wrap(id, '**');
        case 'italic': return this.wrap(id, '__');
        case 'strike': return this.wrap(id, '~~');
        case 'highlight': return this.wrap(id, '==');
        case 'link': return this.insertLink(id);
        case 'table': return this.insertTable(id);
        case 'move': return this.openMove(id);
        case 'delete': return this.deleteItem(id);
      }
    });
  }

  isEditing(el) {
    const t = el.closest('.text');
    return t && document.activeElement === t;
  }

  command(cmd, id) {
    if (cmd === 'undo') return this.undo();
    if (cmd === 'redo') return this.undo(true);
    if (cmd === 'palette') { this.palette.hidden = !this.palette.hidden; return; }
    if (!id || !this.o.get(id)) return;
    switch (cmd) {
      case 'indent': return this.indent(id);
      case 'outdent': return this.outdent(id);
      case 'up': return this.moveUp(id);
      case 'down': return this.moveDown(id);
      case 'done': return this.toggleDone(id);
      case 'zoom': return this.o.isCell(id) ? undefined : this.zoomTo(id);
      case 'move': return this.openMove(id);
      case 'delete': return this.deleteItem(id);
      case 'collapse': {
        const target = this.o.isCell(id) ? this.cellPos(id).table.id : id;
        return this.setCollapsed(target, !this.o.get(target).c);
      }
    }
  }

  syncText(el) {
    let t = el.textContent;
    if (t.includes('\n')) {
      const off = getCaret(el);
      t = t.replace(/\n/g, ' ');
      el.textContent = t;
      setCaret(el, off ?? t.length);
    }
    const id = el.dataset.id;
    const n = this.o.get(id);
    if (n && n.t !== t) {
      this.o.update(id, { t });
      if (this.o.isDoc(id)) {
        const name = this.docs.querySelector(`[data-doc="${id}"] .name`);
        if (name) name.textContent = t || 'Untitled';
      }
      this.onChange();
    }
  }

  onKey(e) {
    const el = e.target;
    if (!el.classList.contains('text')) return;
    if (el.dataset.new !== undefined && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) this.materialize(el);
    const id = el.dataset.id;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const plain = !mod && !e.altKey && !e.shiftKey;

    // Table cells
    if (this.o.isCell(id)) {
      if (key === 'Tab') { handled(); return this.cellStep(id, e.shiftKey ? -1 : 1); }
      // Row color: Ctrl+Shift+0..6, or Ctrl+Alt+0..6 (headings don't apply in
      // cells, and some PCs swallow Ctrl+Shift+0).
      if (mod && (e.shiftKey !== e.altKey) && /^(Digit|Numpad)[0-6]$/.test(e.code)) {
        handled();
        return this.setRowColor(id, Number(e.code.slice(-1)));
      }
      if (mod && e.altKey && !e.shiftKey && key.startsWith('Arrow')) {
        handled();
        if (key === 'ArrowUp') return this.addRow(id, false);
        if (key === 'ArrowDown') return this.addRow(id, true);
        if (key === 'ArrowLeft') return this.addCol(id, false);
        return this.addCol(id, true);
      }
      if ((key === 'ArrowUp' || key === 'ArrowDown') && plain) {
        const up = key === 'ArrowUp';
        if (!caretOnEdgeLine(el, up)) return;
        handled();
        return this.cellVertical(id, up, getCaret(el) ?? 0);
      }
    }

    if (mod && e.shiftKey && !e.altKey && key === 'Backspace') { handled(); return this.deleteItem(id); }
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyM') { handled(); return this.openMove(id); }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'Period') {
      handled();
      const target = this.o.isCell(id) ? this.cellPos(id).table.id : id;
      return this.setCollapsed(target, !this.o.get(target).c);
    }
    if (mod && e.altKey && !e.shiftKey && e.code === 'KeyT') { handled(); return this.insertTable(id); }
    if (key === 'Tab') { handled(); return e.shiftKey ? this.outdent(id) : this.indent(id); }
    if (mod && key === 'Enter') { handled(); return this.toggleDone(id); }
    if (mod && key.toLowerCase() === 'z') { handled(); return this.undo(e.shiftKey); }
    if (mod && key.toLowerCase() === 'y') { handled(); return this.undo(true); }
    if ((mod || e.altKey) && e.shiftKey && key === 'ArrowUp') { handled(); return this.moveUp(id); }
    if ((mod || e.altKey) && e.shiftKey && key === 'ArrowDown') { handled(); return this.moveDown(id); }
    if (mod && key === 'ArrowUp') { handled(); return this.setCollapsed(id, true); }
    if (mod && key === 'ArrowDown') { handled(); return this.setCollapsed(id, false); }
    if (mod && !e.altKey && /^(Digit|Numpad)[0-6]$/.test(e.code)) { handled(); return this.setColor(id, Number(e.code.slice(-1))); }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyH') { handled(); return this.wrap(id, '=='); }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyT') { handled(); return this.wrap(id, '~~'); }
    if (mod && e.altKey && !e.shiftKey && /^(Digit|Numpad)[0-3]$/.test(e.code)) { handled(); return this.setHeading(id, Number(e.code.slice(-1))); }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyB') { handled(); return this.wrap(id, '**'); }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyI') { handled(); return this.wrap(id, '__'); }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { handled(); return this.insertLink(id); }
    if (e.altKey && key === 'ArrowRight') { handled(); return this.zoomTo(id); }
    if (e.altKey && key === 'ArrowLeft') {
      handled();
      const z = this.o.get(this.zoom);
      if (!this.o.isDoc(z.id)) { const back = z.id; this.zoomTo(z.p); this.focus(back, 'end'); }
      return;
    }
    if (key === 'Escape') { handled(); el.blur(); return; }

    if ((key === 'ArrowUp' || key === 'ArrowDown') && plain) {
      const up = key === 'ArrowUp';
      if (!caretOnEdgeLine(el, up)) return;
      const els = [...this.main.querySelectorAll('.text')];
      const target = els[els.indexOf(el) + (up ? -1 : 1)];
      if (!target) return;
      handled();
      const off = getCaret(el) ?? 0;
      target.focus({ preventScroll: true });
      setCaret(target, Math.min(off, target.textContent.length));
      target.scrollIntoView({ block: 'nearest' });
    }
  }
}

Object.assign(UI.prototype, tableMethods);

// ---------- helpers ----------

const trim =(s) => (s.length > 40 ? s.slice(0, 40) + '…' : s);

const svg = (body) =>
  `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${body}</svg>`;
// The two icons left of a line's text: a zoom magnifier that appears on
// hover, then the line's marker — a dot, or a triangle when the line has
// children (click to collapse/expand). Either marker can be dragged.
const ZOOM_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.2 15.2L21 21M10.5 7.5v6M7.5 10.5h6"/></svg>';
function marker(hasKids, open) {
  const title = hasKids ? 'Click to collapse or expand, drag to move' : 'Drag to move';
  return (
    `<span class="zoom" title="Zoom in (Alt+→)">${ZOOM_ICON}</span>` +
    `<span class="bullet${hasKids ? (open ? ' kids open' : ' kids') : ''}" title="${title}"></span>`
  );
}

// Page with a folded top-right corner.
const ICON_DOC = svg('<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>');
const ICON_FOLDER = svg('<path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/>');
const ICON_FOLDER_OPEN = svg('<path d="M1.5 13.5v-10h4.5l1.5 1.5h6v2"/><path d="M1.5 13.5l2-6h12l-2 6z"/>');
const matches = (text, terms) => {
  const t = text.toLowerCase();
  return terms.every((w) => t.includes(w));
};
const colorClass = (n) => (n.cl ? ` cl-${n.cl}` : '');

function lastChildId(o, pid) {
  const k = o.children(pid);
  return k.length ? k[k.length - 1].id : null;
}

// Caret offset in characters from the start of el, or null if not inside el.
export function getCaret(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.focusNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(sel.focusNode, sel.focusOffset);
  return r.toString().length;
}

// A formatting marker (**, __, [](…)) that is hidden while editing.
export const hiddenMarker = (node) =>
  !document.body.classList.contains('show-md') && !!node.parentElement?.closest('.md');

const STYLE_MARKS = ['**', '__', '~~', '=='];

// DOM position [node, offset] for a character offset in el. Never inside a
// hidden marker (typing there would be invisible): such positions move to
// just after the marker.
function domPos(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node;
  while ((node = walker.nextNode())) {
    if (hiddenMarker(node) && left <= node.length) {
      left = 0;
      continue;
    }
    if (left <= node.length) return [node, left];
    left -= node.length;
  }
  return [el, el.childNodes.length];
}

export function setCaret(el, offset) {
  setSelectionRange(el, offset, offset);
}

export function setSelectionRange(el, start, end) {
  const sel = getSelection();
  const r = document.createRange();
  r.setStart(...domPos(el, start));
  if (end !== start) r.setEnd(...domPos(el, end));
  else r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Is the caret on the first (up) / last (down) visual line of a wrapped item?
function caretOnEdgeLine(el, up) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const rect = sel.getRangeAt(0).getClientRects()[0];
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return up ? rect.top - box.top < lh * 0.8 : box.bottom - rect.bottom < lh * 0.8;
}
