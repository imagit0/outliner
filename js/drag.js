// Drag and drop for items (by their bullet) and documents (in the sidebar).
//
// Built on pointer events so the same code handles mouse and touch:
//   mouse: press and move a few pixels to start dragging
//   touch: long-press (~350ms) to start, so normal taps and scrolling still work
//
// A dragged item is shown as a copy of its line where it would land, with the
// other lines reflowing around it; the original stays greyed until the drop.
// Targets are worked out from where the lines were when the drag started, so
// the reflow can't change what the pointer is over. Collapsed lines stay closed.
//
// Drop targets:
//   item row      top half = before, bottom half = after; bottom half while
//                 pointing further right (or onto an expanded item) = first child;
//                 left of the last line in a group = after its parent
//   above lines   first child of the zoomed item
//   below lines   after the last top-level item
//   sidebar doc   item: middle = move into that document, edges = becomes a
//                 document there; document/folder: before / after (reorder)
//   sidebar folder  middle = into the folder (an item becomes a document
//                 there), edges = before / after

const $ = (s) => document.querySelector(s);
const LONG_PRESS = 350;
const EDGE = 70; // px from top/bottom where the page auto-scrolls

export class Drag {
  constructor(ui) {
    this.ui = ui;
    this.line = $('#drop-line');
    this.s = null; // current gesture
    this.dropTime = 0;

    document.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', () => this.cancel());
    // Once a touch drag is active, stop the page from scrolling under it.
    document.addEventListener('touchmove', (e) => { if (this.s && this.s.active) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', (e) => { if (this.s) e.preventDefault(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.s && this.s.active) this.cancel(); });
    // Swallow the click that follows a drop (it would zoom / open a doc).
    document.addEventListener('click', (e) => {
      if (this.justDropped()) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  justDropped() { return Date.now() - this.dropTime < 400; }

  down(e) {
    if (e.button !== 0 || this.s) return;
    const bullet = e.target.closest('#outline .bullet');
    const doc = !bullet && e.target.closest('#docs .entry');
    if (!bullet && !doc) return;
    if (doc && e.target.closest('button')) return;
    if (bullet && !bullet.closest('.item').dataset.item) return; // placeholder line
    this.s = {
      kind: bullet ? 'item' : 'doc',
      id: bullet ? bullet.closest('.item').dataset.item : doc.dataset.doc,
      src: bullet ? bullet.closest('.item') : doc,
      pid: e.pointerId,
      touch: e.pointerType !== 'mouse',
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      active: false,
    };
    if (this.s.touch) this.s.timer = setTimeout(() => this.start(), LONG_PRESS);
    else e.preventDefault(); // no text selection while dragging with a mouse
  }

  move(e) {
    const s = this.s;
    if (!s || e.pointerId !== s.pid) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.active) {
      const dist = Math.hypot(s.x - s.x0, s.y - s.y0);
      if (s.touch) { if (dist > 10) this.reset(); return; } // it's a scroll
      if (dist < 5) return;
      this.start();
    }
    e.preventDefault();
    this.update();
  }

  up(e) {
    const s = this.s;
    if (!s || e.pointerId !== s.pid) return;
    if (!s.active) return this.reset();
    const t = this.target;
    this.end();
    this.dropTime = Date.now();
    if (t) this.ui.drop(s.id, t.id, t.where);
  }

  cancel() {
    if (this.s && this.s.active) {
      this.end();
      this.dropTime = Date.now();
    } else {
      this.reset();
    }
  }

  start() {
    const s = this.s;
    if (!s) return;
    clearTimeout(s.timer);
    s.active = true;
    if (s.touch && navigator.vibrate) navigator.vibrate(15);
    if (s.kind === 'doc') {
      const n = this.ui.o.get(s.id);
      this.ghost = document.createElement('div');
      this.ghost.className = 'drag-ghost';
      this.ghost.textContent = (n && n.t) ? (n.t.length > 50 ? n.t.slice(0, 50) + '…' : n.t) : 'Untitled';
      document.body.append(this.ghost);
    } else {
      this.snapshot();
    }
    document.body.classList.add('dragging');
    s.src.classList.add('drag-src');
    this.update();
    const scroll = () => {
      if (!this.s || !this.s.active) return;
      const y = this.s.y;
      const dy = y < EDGE ? -(EDGE - y) / 4 : y > innerHeight - EDGE ? (y - innerHeight + EDGE) / 4 : 0;
      if (dy && !this.overSidebar) {
        window.scrollBy(0, dy);
        this.update();
      }
      this.raf = requestAnimationFrame(scroll);
    };
    this.raf = requestAnimationFrame(scroll);
  }

  end() {
    cancelAnimationFrame(this.raf);
    if (this.ghost) this.ghost.remove();
    this.ghost = null;
    document.body.classList.remove('dragging');
    if (this.s) this.s.src.classList.remove('drag-src');
    this.clearMarks();
    this.clearPreview();
    this.lines = null;
    this.reset();
  }

  reset() {
    if (this.s) clearTimeout(this.s.timer);
    this.s = null;
    this.target = null;
  }

  clearMarks() {
    this.line.hidden = true;
    for (const el of document.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
  }

  showLine(top, left, right) {
    this.line.hidden = false;
    this.line.style.top = `${top - 1}px`;
    this.line.style.left = `${left}px`;
    this.line.style.width = `${Math.max(right - left, 40)}px`;
  }

  // Work out the drop target under the pointer and show where it would land.
  update() {
    const s = this.s;
    if (this.ghost) this.ghost.style.transform = `translate(${s.x + 14}px, ${s.y + 10}px)`;
    this.clearMarks();
    this.target = null;
    const el = document.elementFromPoint(s.x, s.y);
    this.overSidebar = !!(el && el.closest('#sidebar'));
    if (!el || this.overSidebar) this.clearPreview();
    if (!el) return;

    // Sidebar documents and folders
    const docEl = el.closest('#docs .entry');
    if (docEl) {
      const id = docEl.dataset.doc;
      if (id === s.id || this.ui.o.isAncestor(s.id, id)) return; // into itself
      const isFolder = !!this.ui.o.get(id).f;
      const r = docEl.getBoundingClientRect();
      const f = (s.y - r.top) / r.height;
      let where;
      if (s.kind === 'doc' && !isFolder) where = f < 0.5 ? 'before' : 'after';
      else where = f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'into';
      if (where === 'into') {
        docEl.classList.add('drop-into');
      } else {
        const indent = parseFloat(getComputedStyle(docEl).paddingLeft) || 8;
        this.showLine(where === 'before' ? r.top : r.bottom, r.left + indent, r.right - 8);
      }
      this.target = { id, where };
      return;
    }
    if (s.kind === 'doc' || this.overSidebar) return; // documents and folders stay in the sidebar

    const t = this.itemTarget();
    this.target = t && !this.isCurrentPlace(t) ? t : null;
    this.showPreview(this.target);
  }

  // Would this drop leave the line where it already is? (Just above the line
  // below it, just below the line above it, or first under its own parent.)
  isCurrentPlace(t) {
    const src = this.s.src;
    let prev = src.previousElementSibling;
    if (prev && prev === this.preview) prev = prev.previousElementSibling;
    const next = this.nextItem(src);
    if (t.where === 'before') return next?.dataset.item === t.id;
    if (t.where === 'after') return prev?.dataset.item === t.id;
    const parent = src.parentElement.closest('.item')?.dataset.item ?? this.ui.zoom;
    return !prev && parent === t.id;
  }

  // Where the outline's lines are, in page coordinates, with no preview in the
  // way. Tables count as one line (their cells aren't drop targets).
  snapshot() {
    const main = $('#outline');
    this.clearPreview();
    const s = this.s;
    s.src = main.querySelector(`.item[data-item="${s.id}"]`) || s.src;
    s.src.classList.add('drag-src');
    const items = [...main.querySelectorAll('.list .item[data-item]')]
      .filter((el) => el.dataset.item && !el.closest('table'));
    const top = scrollY;
    this.lines = items.map((item) => {
      const row = item.querySelector(':scope > .row');
      const r = row.getBoundingClientRect();
      return {
        item, row, id: item.dataset.item,
        top: r.top + top,
        bottom: r.bottom + top,
        textLeft: row.querySelector('.text').getBoundingClientRect().left,
        expanded: !!item.querySelector(':scope > .children'),
        isTable: item.classList.contains('table-item'),
      };
    });
    this.byItem = new Map(this.lines.map((l) => [l.item, l]));
    const tops = this.lines.filter((l) => l.item.parentElement.classList.contains('list'));
    const last = tops[tops.length - 1];
    this.listEnd = last ? { line: last, bottom: last.item.getBoundingClientRect().bottom + top } : null;
  }

  itemTarget() {
    const s = this.s;
    // A sync redrew the outline under us: measure again.
    if (!this.lines || !this.lines.length || !this.lines[0].item.isConnected) this.snapshot();
    const lines = this.lines;
    if (!lines.length) return null;
    const y = s.y + scrollY;
    const allowed = (id) => id !== s.id && !this.ui.o.isAncestor(s.id, id);

    // Above the first line: the first item. Below them all: the last item.
    if (y < lines[0].top) return $('#outline .title') ? { id: this.ui.zoom, where: 'child' } : null;
    if (this.listEnd && y > this.listEnd.bottom) {
      const { id } = this.listEnd.line;
      return allowed(id) ? { id, where: 'after' } : null;
    }

    // The last line starting above the pointer (a table's cells belong to it).
    let lo = 0;
    for (let hi = lines.length - 1; lo < hi;) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].top <= y) lo = mid;
      else hi = mid - 1;
    }
    const line = lines[lo];
    if (!allowed(line.id)) return null; // onto itself
    if (y < (line.top + line.bottom) / 2) return { id: line.id, where: 'before' };
    if (!line.isTable && (line.expanded || s.x > line.textLeft + 40)) return { id: line.id, where: 'child' };

    // Left of a group's last line: climb out to the level the pointer is at.
    let at = line;
    while (s.x < at.textLeft && !this.nextItem(at.item)) {
      const up = this.byItem.get(at.item.parentElement.closest('.item'));
      if (!up) break;
      at = up;
    }
    return { id: at.id, where: 'after' };
  }

  // The sibling below an item, ignoring the one being dragged.
  nextItem(item) {
    let next = item.nextElementSibling;
    while (next && (next === this.s.src || next === this.preview)) next = next.nextElementSibling;
    return next;
  }

  // Show a copy of the dragged line at the target, reflowing the lines below.
  showPreview(t) {
    const key = t ? `${t.id}|${t.where}` : '';
    if (key === this.previewKey && (!t || this.preview?.isConnected)) return;
    this.clearPreview();
    if (!t) return;
    const main = $('#outline');
    const p = this.previewEl();
    if (t.id === this.ui.zoom) {
      main.querySelector('.list')?.prepend(p);
    } else {
      const item = main.querySelector(`.item[data-item="${t.id}"]`);
      if (!item) return;
      if (t.where === 'before') item.before(p);
      else if (t.where === 'after') item.after(p);
      else {
        let kids = item.querySelector(':scope > .children');
        if (!kids) { // no list showing (a leaf, or collapsed, which stays closed)
          kids = this.previewWrap = document.createElement('div');
          kids.className = 'children';
          item.append(kids);
        }
        kids.prepend(p);
      }
    }
    this.preview = p;
    this.previewKey = key;
  }

  previewEl() {
    const src = this.s.src;
    const p = document.createElement('div');
    p.className = `item drag-preview${src.classList.contains('done') ? ' done' : ''}`;
    const row = src.querySelector(':scope > .row').cloneNode(true);
    row.classList.remove('selected');
    // It's only a picture: nothing should find or edit it as the real line.
    const text = row.querySelector('.text');
    text.removeAttribute('contenteditable');
    delete text.dataset.id;
    row.querySelector('.bullet')?.classList.remove('open');
    p.append(row);
    return p;
  }

  clearPreview() {
    this.preview?.remove();
    this.previewWrap?.remove();
    this.preview = this.previewWrap = null;
    this.previewKey = '';
  }
}
