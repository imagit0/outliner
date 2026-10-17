// Outline editor: rendering, editing, keyboard and touch commands.
//
// Each item's text is a contenteditable="plaintext-only" element whose
// textContent is always the raw item text (see format.js). Typing only updates
// the model; structural commands (split, indent, move...) mutate the model and
// re-render the visible tree, then restore focus and caret.

import { ROOT } from './model.js';
import { format, esc } from './format.js';

const $ = (sel, el = document) => el.querySelector(sel);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export class UI {
  constructor(outline, { onChange, prefs }) {
    this.o = outline;
    this.onChange = onChange;
    this.prefs = prefs; // { showDone }
    this.zoom = ROOT;
    this.query = '';
    this.undoStack = [];
    this.redoStack = [];
    this.focusId = null;

    this.main = $('#outline');
    this.crumbs = $('#crumbs');
    this.search = $('#search');
    this.toolbar = $('#toolbar');

    this.bind();
    this.zoomFromHash();
  }

  // ---------- rendering ----------

  render() {
    if (!this.o.get(this.zoom)) this.zoom = ROOT;
    const visible = this.visibleSet();
    const z = this.o.get(this.zoom);
    let html = '';
    if (this.zoom !== ROOT) {
      html += `<div class="title text${z.d ? ' done' : ''}" contenteditable="plaintext-only" spellcheck="true" data-id="${z.id}">${format(z.t)}</div>`;
    }
    const kids = this.renderChildren(this.zoom, visible);
    html += kids
      ? `<div class="list">${kids}</div>`
      : this.query
        ? `<p class="empty">No matches.</p>`
        : `<button class="add" type="button">+ Add item</button>`;
    this.main.innerHTML = html;
    this.renderCrumbs();
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
    const kids = this.o.children(n.id).filter((k) => (visible ? visible.has(k.id) : this.prefs.showDone || !k.d));
    const has = kids.length > 0;
    const open = has && (!n.c || !!visible);
    const inner = open ? this.renderChildren(n.id, visible) : '';
    return (
      `<div class="item${n.d ? ' done' : ''}" data-item="${n.id}">` +
      `<div class="row">` +
      `<span class="toggle${has ? (open ? ' open' : ' closed') : ''}" aria-hidden="true"></span>` +
      `<span class="bullet${has && !open ? ' folded' : ''}" title="Zoom in"></span>` +
      `<div class="text" contenteditable="plaintext-only" spellcheck="true" data-id="${n.id}">${format(n.t)}</div>` +
      `</div>` +
      (inner ? `<div class="children">${inner}</div>` : '') +
      `</div>`
    );
  }

  renderCrumbs() {
    if (this.zoom === ROOT) {
      this.crumbs.innerHTML = '';
      return;
    }
    const parts = [`<a href="#" data-zoom="${ROOT}">Home</a>`];
    for (const a of this.o.ancestors(this.zoom)) {
      if (a.id === ROOT) continue;
      parts.push(`<a href="#${a.id}" data-zoom="${a.id}">${esc(trim(a.t) || '…')}</a>`);
    }
    this.crumbs.innerHTML = parts.join('<span class="sep">›</span>');
  }

  // With a search query: the set of matching nodes plus their ancestors (up to
  // the zoom root). Without one: null (show everything).
  visibleSet() {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const set = new Set();
    for (const n of Object.values(this.o.nodes)) {
      if (n.id === ROOT || n.id === this.zoom) continue;
      if (n.d && !this.prefs.showDone) continue;
      const t = n.t.toLowerCase();
      if (!terms.every((w) => t.includes(w))) continue;
      if (this.zoom !== ROOT && !this.o.isAncestor(this.zoom, n.id)) continue;
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

  focus(id, offset = 'end') {
    const el = this.textEl(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    setCaret(el, offset === 'end' ? el.textContent.length : offset);
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
    this.undoStack.push({ nodes: this.o.snapshot(), focus: this.currentFocus(), kind, id, time: now });
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
    to.push({ nodes: this.o.snapshot(), focus: this.currentFocus(), kind: 'op', time: 0 });
    this.o.restore(rec.nodes);
    this.render();
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
    if (f) this.focus(f.id, f.off);
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
    if (id === this.zoom) return;
    const off = this.caretOf(id);
    this.op(() => {
      const prev = this.o.prevSibling(id);
      if (!prev) return false;
      const kids = this.o.children(prev.id);
      this.o.move(id, prev.id, kids.length ? kids[kids.length - 1].id : null);
      if (prev.c) this.o.update(prev.id, { c: false });
      return { id, off };
    });
  }

  outdent(id) {
    const n = this.o.get(id);
    if (id === this.zoom || n.p === this.zoom) return;
    const off = this.caretOf(id);
    this.op(() => {
      const parent = this.o.get(n.p);
      this.o.move(id, parent.p, parent.id);
      return { id, off };
    });
  }

  moveUp(id) {
    if (id === this.zoom) return;
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
    if (id === this.zoom) return;
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

  setCollapsed(id, c) {
    const n = this.o.get(id);
    if (!n || n.c === c || !this.o.hasChildren(id) || id === this.zoom) return;
    const off = this.caretOf(id);
    this.op(() => {
      this.o.update(id, { c });
      return document.activeElement?.dataset?.id === id ? { id, off } : null;
    });
  }

  addItem() {
    this.op(() => {
      const kids = this.o.children(this.zoom);
      const c = this.o.insert(this.zoom, kids.length ? kids[kids.length - 1].id : null, {});
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
      // stack[d] = last node at relative depth d
      const stack = [this.o.get(id)];
      let last = stack[0];
      for (const it of items.slice(1)) {
        const d = Math.min(it.depth - base, stack.length);
        let node;
        if (d === 0) node = this.o.insert(stack[0].p, stack[0].id, { t: it.t });
        else node = this.o.insert(stack[d - 1].id, lastChildId(this.o, stack[d - 1].id), { t: it.t });
        stack[d] = node;
        stack.length = d + 1;
        last = node;
      }
      if (rest) this.o.update(last.id, { t: last.t + rest });
      return { id: last.id, off: last.t.length - rest.length };
    });
  }

  zoomTo(id) {
    const hash = id === ROOT ? '' : '#' + id;
    if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
    this.zoomFromHash();
  }

  zoomFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    this.zoom = id && this.o.get(id) ? id : ROOT;
    this.render();
    window.scrollTo(0, 0);
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

    m.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('.add')) return this.addItem();
      const row = t.closest('.row');
      const id = row && row.closest('.item').dataset.item;
      if (t.classList.contains('toggle') && id) {
        if (this.o.hasChildren(id)) this.setCollapsed(id, !this.o.get(id).c);
      } else if (t.classList.contains('bullet') && id) {
        this.zoomTo(id);
      } else if (t.classList.contains('tag') && !this.isEditing(t)) {
        this.setQuery(t.textContent);
      }
    });

    // Links open on tap when not editing that item (or with Ctrl/Cmd).
    m.addEventListener('pointerdown', (e) => {
      const link = e.target.closest('.link');
      if (link && (!this.isEditing(link) || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        window.open(link.dataset.href, '_blank', 'noopener');
      }
      const tag = e.target.closest('.tag');
      if (tag && !this.isEditing(tag)) e.preventDefault();
    });

    m.addEventListener('focusin', (e) => {
      if (!e.target.classList.contains('text')) return;
      this.focusId = e.target.dataset.id;
      document.body.classList.add('editing');
    });

    m.addEventListener('focusout', (e) => {
      const el = e.target;
      if (!el.classList.contains('text')) return;
      const n = this.o.get(el.dataset.id);
      if (n && el.isConnected) el.innerHTML = format(n.t);
      setTimeout(() => {
        if (!document.activeElement?.classList?.contains('text')) document.body.classList.remove('editing');
      }, 0);
      if (el.classList.contains('title')) this.renderCrumbs();
    });

    m.addEventListener('beforeinput', (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains('text')) return;
      const id = el.dataset.id;
      switch (e.inputType) {
        case 'insertParagraph':
        case 'insertLineBreak': {
          e.preventDefault();
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
      if (e.target.classList.contains('text')) this.syncText(e.target);
    });

    m.addEventListener('paste', (e) => {
      const el = e.target.closest && e.target.closest('.text');
      if (!el) return;
      const text = e.clipboardData.getData('text/plain');
      if (!text.includes('\n')) return;
      e.preventDefault();
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
        const first = this.visibleIds()[0];
        if (first) this.focus(first, 'end');
      }
    });

    this.crumbs.addEventListener('click', (e) => {
      const a = e.target.closest('[data-zoom]');
      if (!a) return;
      e.preventDefault();
      this.zoomTo(a.dataset.zoom);
    });

    window.addEventListener('popstate', () => this.zoomFromHash());

    // Touch toolbar. Preventing pointerdown/mousedown keeps focus (and the
    // soft keyboard) on the item being edited.
    const keep = (e) => { if (e.target.closest('button')) e.preventDefault(); };
    this.toolbar.addEventListener('pointerdown', keep);
    this.toolbar.addEventListener('mousedown', keep);
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      const id = document.activeElement?.dataset?.id || this.focusId;
      this.command(b.dataset.cmd, id);
    });
  }

  isEditing(el) {
    const t = el.closest('.text');
    return t && document.activeElement === t;
  }

  command(cmd, id) {
    if (cmd === 'undo') return this.undo();
    if (cmd === 'redo') return this.undo(true);
    if (!id || !this.o.get(id)) return;
    switch (cmd) {
      case 'indent': return this.indent(id);
      case 'outdent': return this.outdent(id);
      case 'up': return this.moveUp(id);
      case 'down': return this.moveDown(id);
      case 'done': return this.toggleDone(id);
      case 'zoom': return this.zoomTo(id);
      case 'collapse': return this.setCollapsed(id, !this.o.get(id).c);
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
    if (this.o.get(id) && this.o.get(id).t !== t) {
      this.o.update(id, { t });
      this.onChange();
    }
  }

  onKey(e) {
    const el = e.target;
    if (!el.classList.contains('text')) return;
    const id = el.dataset.id;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (key === 'Tab') { handled(); return e.shiftKey ? this.outdent(id) : this.indent(id); }
    if (mod && key === 'Enter') { handled(); return this.toggleDone(id); }
    if (mod && key.toLowerCase() === 'z') { handled(); return this.undo(e.shiftKey); }
    if (mod && key.toLowerCase() === 'y') { handled(); return this.undo(true); }
    if ((mod || e.altKey) && e.shiftKey && key === 'ArrowUp') { handled(); return this.moveUp(id); }
    if ((mod || e.altKey) && e.shiftKey && key === 'ArrowDown') { handled(); return this.moveDown(id); }
    if (mod && key === 'ArrowUp') { handled(); return this.setCollapsed(id, true); }
    if (mod && key === 'ArrowDown') { handled(); return this.setCollapsed(id, false); }
    if (e.altKey && key === 'ArrowRight') { handled(); return this.zoomTo(id); }
    if (e.altKey && key === 'ArrowLeft') {
      handled();
      const z = this.o.get(this.zoom);
      if (z.id !== ROOT) { const back = z.id; this.zoomTo(z.p); this.focus(back, 'end'); }
      return;
    }
    if (key === 'Escape') { handled(); el.blur(); return; }

    if ((key === 'ArrowUp' || key === 'ArrowDown') && !e.shiftKey && !mod && !e.altKey) {
      const up = key === 'ArrowUp';
      if (!caretOnEdgeLine(el, up)) return;
      const ids = this.visibleIds();
      const i = ids.indexOf(id) + (up ? -1 : 1);
      if (i < 0 || i >= ids.length) return;
      handled();
      const off = getCaret(el) ?? 0;
      const target = this.textEl(ids[i]);
      this.focus(ids[i], Math.min(off, target.textContent.length));
    }
  }
}

// ---------- helpers ----------

const trim = (s) => (s.length > 40 ? s.slice(0, 40) + '…' : s);

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

export function setCaret(el, offset) {
  const sel = getSelection();
  const r = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node;
  while ((node = walker.nextNode())) {
    if (left <= node.length) {
      r.setStart(node, left);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    left -= node.length;
  }
  r.selectNodeContents(el);
  r.collapse(false);
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
