// Selecting whole lines with the mouse.
//
// Dragging from one line into another switches from text selection to line
// selection; Shift+click on another line selects the range from the line
// being edited (or the current selection's start). While lines are selected:
//   Delete / Backspace   delete them (with their children)
//   Ctrl+C / Ctrl+X      copy / cut them as indented text (children included)
//   Tab / Shift+Tab      indent / outdent
//   Ctrl+0..6            color
//   Ctrl+Enter           mark complete (or not)
//   Ctrl+D               duplicate
//   Esc, a click, or typing   ends the selection
// Table cells are not part of line selection (a table counts as one line).
//
// These methods are mixed into UI (see the bottom of ui.js).

const lastChildId = (o, pid) => {
  const k = o.children(pid);
  return k.length ? k[k.length - 1].id : null;
};

export const selectMethods = {
  bindLineSelect() {
    const m = this.main;
    const itemOf = (el) => {
      const item = el?.closest?.('#outline .item');
      if (!item || !item.dataset.item) return null;
      return item;
    };

    m.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const text = e.target.closest('.text');
      const item = text && !text.classList.contains('cell') && !text.classList.contains('title') ? itemOf(text) : null;
      // Shift+click: range from the line being edited / selection start.
      if (e.shiftKey && item) {
        const from = this.lineSel?.anchor || (document.activeElement?.closest?.('#outline .item[data-item]')?.dataset.item);
        if (from && from !== item.dataset.item) {
          e.preventDefault();
          document.activeElement?.blur();
          this.setLineSelection(from, item.dataset.item);
          return;
        }
      }
      this.clearLineSelection();
      if (item) this.dragSel = { anchor: item.dataset.item, active: false };
    });

    document.addEventListener('mousemove', (e) => {
      const d = this.dragSel;
      if (!d) return;
      if (!(e.buttons & 1)) { this.dragSel = null; return; }
      const item = itemOf(document.elementFromPoint(e.clientX, e.clientY));
      if (!item) return;
      const id = item.dataset.item;
      if (!d.active && id === d.anchor) return; // still selecting text in one line
      if (!d.active) {
        d.active = true;
        document.activeElement?.blur();
      }
      getSelection().removeAllRanges();
      this.setLineSelection(d.anchor, id);
    });

    document.addEventListener('mouseup', () => { this.dragSel = null; });

    // Any press outside the outline (sidebar, header…) ends the selection.
    document.addEventListener('mousedown', (e) => {
      if (this.lineSel && !this.main.contains(e.target) && !e.target.closest('#ctx-menu, dialog')) this.clearLineSelection();
    });

    document.addEventListener('keydown', (e) => this.lineSelKey(e), true);
    document.addEventListener('copy', (e) => this.lineSelCopy(e, false));
    document.addEventListener('cut', (e) => this.lineSelCopy(e, true));
  },

  // Visible outline lines in order (not table internals, not placeholders).
  lineIds() {
    return [...this.main.querySelectorAll('.list .item[data-item]')]
      .filter((el) => el.dataset.item && !el.closest('table'))
      .map((el) => el.dataset.item);
  },

  setLineSelection(anchor, focus) {
    const ids = this.lineIds();
    const a = ids.indexOf(anchor), b = ids.indexOf(focus);
    if (a < 0 || b < 0) return;
    // A selected line always brings its children (that's what copy, delete
    // etc. act on), so stretch the range over the children of every line in
    // it. Children come right after their parent in display order.
    const lo = Math.min(a, b);
    let hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      while (hi + 1 < ids.length && this.o.isAncestor(ids[i], ids[hi + 1])) hi++;
    }
    this.lineSel = { anchor, focus, ids: ids.slice(lo, hi + 1) };
    this.paintLineSelection();
  },

  paintLineSelection() {
    for (const el of this.main.querySelectorAll('.row.selected')) el.classList.remove('selected');
    document.body.classList.toggle('line-select', !!this.lineSel);
    if (!this.lineSel) return;
    this.lineSel.ids = this.lineSel.ids.filter((id) => this.o.get(id));
    for (const id of this.lineSel.ids) this.main.querySelector(`.item[data-item="${id}"] > .row`)?.classList.add('selected');
    if (!this.lineSel.ids.length) this.clearLineSelection();
  },

  clearLineSelection() {
    if (!this.lineSel) return;
    this.lineSel = null;
    this.paintLineSelection();
  },

  // Selected lines whose parent isn't also selected (each brings its children).
  lineSelTop() {
    const set = new Set(this.lineSel.ids);
    return this.lineSel.ids.filter((id) => !this.o.ancestors(id).some((a) => set.has(a.id)));
  },

  lineSelKey(e) {
    if (!this.lineSel) return;
    if (e.target.closest?.('input, textarea, dialog, .text:focus')) return;
    const mod = e.ctrlKey || e.metaKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { done(); return this.clearLineSelection(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { done(); return this.deleteLines(); }
    if (e.key === 'Tab') { done(); return e.shiftKey ? this.outdentLines() : this.indentLines(); }
    if (mod && !e.shiftKey && !e.altKey && /^(Digit|Numpad)[0-6]$/.test(e.code)) { done(); return this.colorLines(Number(e.code.slice(-1))); }
    if (mod && e.key === 'Enter') { done(); return this.completeLines(); }
    if (mod && !e.shiftKey && e.code === 'KeyD') { done(); return this.duplicateLines(); }
    if (mod && ['KeyC', 'KeyX', 'KeyZ', 'KeyY'].includes(e.code)) return; // copy/cut events, undo
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    this.clearLineSelection(); // anything else: back to normal
  },

  // ---------- actions on selected lines ----------

  deleteLines() {
    const top = this.lineSelTop();
    const ids = this.lineIds();
    const first = ids.indexOf(this.lineSel.ids[0]);
    const prev = ids.slice(0, first).reverse().find((x) => !top.some((t) => x === t || this.o.isAncestor(t, x)));
    this.lineSel = null;
    this.op(() => {
      for (const id of top) this.o.remove(id);
      return prev ? { id: prev, off: 'end' } : null;
    });
    this.paintLineSelection();
  },

  indentLines() {
    const top = this.lineSelTop();
    const first = this.o.get(top[0]);
    const prev = this.o.prevSibling(first.id);
    if (!prev || prev.tb || top.includes(prev.id)) return;
    this.op(() => {
      for (const id of top) {
        const p = this.o.prevSibling(id);
        if (!p || p.tb) continue;
        this.o.move(id, p.id, lastChildId(this.o, p.id));
        if (p.c) this.o.update(p.id, { c: false });
      }
      return null;
    });
    this.paintLineSelection();
  },

  outdentLines() {
    const top = this.lineSelTop();
    if (top.some((id) => { const n = this.o.get(id); return n.p === this.zoom || this.o.isDoc(n.p); })) return;
    this.op(() => {
      // Last first, so lines that end up after the same parent keep their order.
      for (const id of [...top].reverse()) {
        const parent = this.o.get(this.o.get(id).p);
        this.o.move(id, parent.p, parent.id);
      }
      return null;
    });
    this.paintLineSelection();
  },

  colorLines(c) {
    const ids = this.lineSel.ids;
    const next = ids.every((id) => (this.o.get(id).cl || 0) === c) ? 0 : c;
    this.op(() => {
      for (const id of ids) if ((this.o.get(id).cl || 0) !== next) this.o.update(id, { cl: next });
      return null;
    });
    this.paintLineSelection();
  },

  completeLines() {
    const ids = this.lineSel.ids;
    const d = !ids.every((id) => this.o.get(id).d);
    this.op(() => {
      for (const id of ids) this.o.update(id, { d });
      return null;
    });
    this.paintLineSelection();
  },

  duplicateLines() {
    const top = this.lineSelTop();
    const sameParent = top.every((id) => this.o.get(id).p === this.o.get(top[0]).p);
    const copies = [];
    this.op(() => {
      if (sameParent) {
        // Copy the block after its last line: A B -> A B A' B'.
        let after = top[top.length - 1];
        for (const id of top) after = this.o.copySubtree(id, this.o.get(id).p, after).id, copies.push(after);
      } else {
        for (const id of top) copies.push(this.o.copySubtree(id, this.o.get(id).p, id).id);
      }
      return null;
    });
    // Select the copies.
    const ids = this.lineIds();
    const shown = copies.filter((id) => ids.includes(id));
    if (shown.length) this.setLineSelection(shown[0], shown[shown.length - 1]);
  },

  // Copy / cut as indented text (2 spaces per level), children included.
  lineSelCopy(e, cut) {
    if (!this.lineSel || e.target.closest?.('input, textarea, .text:focus')) return;
    const top = this.lineSelTop();
    const lines = [];
    const walk = (id, depth) => {
      const n = this.o.get(id);
      lines.push('  '.repeat(depth) + n.t);
      if (n.tb) {
        for (const row of this.o.children(id)) lines.push('  '.repeat(depth + 1) + '| ' + this.o.children(row.id).map((c) => c.t).join(' | ') + ' |');
        return;
      }
      for (const k of this.o.children(id)) walk(k.id, depth + 1);
    };
    const base = Math.min(...top.map((id) => this.o.ancestors(id).length));
    for (const id of top) walk(id, this.o.ancestors(id).length - base);
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
    if (cut) this.deleteLines();
  },
};
