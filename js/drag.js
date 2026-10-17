// Drag and drop for items (by their bullet) and documents (in the sidebar).
//
// Built on pointer events so the same code handles mouse and touch:
//   mouse: press and move a few pixels to start dragging
//   touch: long-press (~350ms) to start, so normal taps and scrolling still work
//
// Drop targets:
//   item row      top half = before, bottom half = after; bottom half while
//                 pointing further right (or onto an expanded item) = first child
//   title         first child of the zoomed item
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
    const n = this.ui.o.get(s.id);
    this.ghost = document.createElement('div');
    this.ghost.className = 'drag-ghost';
    this.ghost.textContent = (n && n.t) ? (n.t.length > 50 ? n.t.slice(0, 50) + '…' : n.t) : 'Untitled';
    document.body.append(this.ghost);
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
    this.ghost.style.transform = `translate(${s.x + 14}px, ${s.y + 10}px)`;
    this.clearMarks();
    this.target = null;
    const el = document.elementFromPoint(s.x, s.y);
    this.overSidebar = !!(el && el.closest('#sidebar'));
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
    if (s.kind === 'doc') return; // documents and folders stay in the sidebar

    const main = $('#outline');
    const mainR = main.getBoundingClientRect();
    const right = mainR.right - 16;

    // Title: becomes the first item
    const title = el.closest('#outline .title');
    if (title) {
      const r = title.getBoundingClientRect();
      this.showLine(r.bottom + 4, r.left, right);
      this.target = { id: this.ui.zoom, where: 'child' };
      return;
    }

    let row = el.closest('#outline .row');
    if (!row) {
      const item = el.closest('#outline .item');
      if (item) row = item.querySelector(':scope > .row');
    }
    if (!row && main.contains(el)) {
      // Below the list: after the last top-level item.
      const rows = main.querySelectorAll('.list > .item > .row');
      const lastRow = rows[rows.length - 1];
      if (lastRow && s.y > lastRow.getBoundingClientRect().bottom) {
        const lastItem = lastRow.parentElement;
        if (lastItem.dataset.item !== s.id) {
          const r = lastItem.getBoundingClientRect();
          const left = lastRow.querySelector('.text').getBoundingClientRect().left;
          this.showLine(r.bottom, left, right);
          this.target = { id: lastItem.dataset.item, where: 'after' };
        }
      }
      return;
    }
    if (!row) return;

    const item = row.parentElement;
    const id = item.dataset.item;
    if (id === s.id || this.ui.o.isAncestor(s.id, id)) return; // onto itself
    const r = row.getBoundingClientRect();
    const textLeft = row.querySelector('.text').getBoundingClientRect().left;
    const expanded = !!item.querySelector(':scope > .children');
    const isTable = item.classList.contains('table-item');
    if (!id) return; // placeholder line
    let where;
    if (s.y < r.top + r.height / 2) where = 'before';
    else if (!isTable && (expanded || s.x > textLeft + 40)) where = 'child';
    else where = 'after';
    // "after" an expanded item would land below its whole subtree.
    const top = where === 'before' ? r.top : where === 'after' ? item.getBoundingClientRect().bottom : r.bottom;
    this.showLine(top, where === 'child' ? textLeft + 28 : textLeft, right);
    this.target = { id, where };
  }
}
