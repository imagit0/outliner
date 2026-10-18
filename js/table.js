// Tables: an outline item with `tb` set. Its children are rows and each row's
// children are cells; a cell is an ordinary text node, so formatting, colors,
// undo and sync all work as for any other line.
//
// Rows can end up with different numbers of cells (e.g. columns added on two
// devices at once). Rendering pads short rows with placeholder cells that
// become real nodes when focused, so nothing is created behind the user's back.
//
// These methods are mixed into UI (see the bottom of ui.js).

import { format } from './format.js';
import { hiddenMarker } from './ui.js';

const lastChildId = (o, pid) => {
  const k = o.children(pid);
  return k.length ? k[k.length - 1].id : null;
};

export const tableMethods = {
  // ---------- rendering ----------

  renderTable(t) {
    const rows = this.o.children(t.id);
    const cols = Math.max(1, ...rows.map((r) => this.o.children(r.id).length));
    const widths = colWidths(t);
    let html = `<div class="table-wrap"><table class="tbl${t.hd ? ' hd' : ''}${t.nb ? ' nb' : ''}" data-table="${t.id}"><colgroup>`;
    for (let i = 0; i < cols; i++) html += widths[i] ? `<col style="width:${widths[i]}px">` : `<col>`;
    html += `</colgroup>`;
    for (const r of rows) {
      html += `<tr data-row="${r.id}">`;
      const cells = this.o.children(r.id);
      for (let i = 0; i < cols; i++) {
        const c = cells[i];
        html += c
          ? `<td><div class="text cell${c.cl ? ` cl-${c.cl}` : ''}" contenteditable="plaintext-only" spellcheck="true" data-id="${c.id}">${format(c.t)}</div></td>`
          : `<td><div class="text cell" contenteditable="plaintext-only" spellcheck="true" data-id="" data-new="${r.id}|${lastChildId(this.o, r.id) || ''}"></div></td>`;
      }
      html += `</tr>`;
    }
    return html + `</table></div>`;
  },

  // ---------- geometry ----------

  // Position of a cell: { table, rows, r, c, cols }
  cellPos(cellId) {
    const cell = this.o.get(cellId);
    const row = this.o.get(cell.p);
    const table = this.o.get(row.p);
    const rows = this.o.children(table.id);
    const cols = Math.max(1, ...rows.map((x) => this.o.children(x.id).length));
    return { table, rows, r: rows.indexOf(row), c: this.o.children(row.id).indexOf(cell), cols };
  },

  // Focus the cell at (r, c) via the DOM, so placeholder cells work too.
  focusCell(tableId, r, c, off = 'end') {
    const el = this.main.querySelector(`table[data-table="${tableId}"] tr:nth-child(${r + 1}) td:nth-child(${c + 1}) .text`);
    if (!el) return;
    el.focus({ preventScroll: true });
    // focusin may have turned a placeholder into a real cell; re-read its id.
    setCaretEnd(el, off);
    el.scrollIntoView({ block: 'nearest' });
  },

  // ---------- navigation ----------

  // Tab / Shift+Tab: next / previous cell, wrapping across rows. Tab in the
  // last cell adds a row.
  cellStep(id, dir) {
    const { table, rows, r, c, cols } = this.cellPos(id);
    let nr = r, nc = c + dir;
    if (nc >= cols) { nc = 0; nr++; }
    if (nc < 0) { nc = cols - 1; nr--; }
    if (nr < 0) return;
    if (nr >= rows.length) return this.addRow(id, true, 0);
    this.focusCell(table.id, nr, nc, 'end');
  },

  // Up / down between rows (same column). Off the top goes to the table's
  // own line, off the bottom to whatever follows the table.
  cellVertical(id, up, off) {
    const { table, rows, r, c } = this.cellPos(id);
    const nr = r + (up ? -1 : 1);
    if (nr >= 0 && nr < rows.length) return this.focusCell(table.id, nr, c, off);
    if (up) return this.focus(table.id, 'end');
    const all = [...this.main.querySelectorAll('.text')];
    const tableEl = this.main.querySelector(`table[data-table="${table.id}"]`);
    const next = all.find((el) => tableEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !tableEl.contains(el));
    if (next) next.focus();
  },

  // Enter in a cell: move down; in the last row, add a row.
  cellEnter(id) {
    const { table, rows, r, c } = this.cellPos(id);
    if (r + 1 < rows.length) return this.focusCell(table.id, r + 1, c, 'end');
    this.addRow(id, true, c);
  },

  // ---------- structure ----------

  insertTable(id) {
    const spec = prompt('Table size (rows × columns):', '3 x 3');
    if (spec === null) return this.focus(id);
    const m = /(\d+)\D+(\d+)/.exec(spec);
    if (!m) return this.focus(id);
    const rows = Math.min(Math.max(+m[1], 1), 50), cols = Math.min(Math.max(+m[2], 1), 20);
    this.op(() => {
      const n = this.o.get(id);
      let t;
      if (id !== this.zoom && !n.t && !this.o.hasChildren(id) && !this.o.isCell(id)) {
        this.o.update(id, { tb: true, c: false }); // turn the empty line into the table
        t = n;
      } else if (id === this.zoom) {
        t = this.o.insert(id, null, { tb: true });
      } else {
        const anchor = this.o.isCell(id) ? this.cellPos(id).table : n;
        t = this.o.insert(anchor.p, anchor.id, { tb: true });
      }
      let first = null, prevRow = null;
      for (let i = 0; i < rows; i++) {
        const row = this.o.insert(t.id, prevRow, {});
        prevRow = row.id;
        let prevCell = null;
        for (let j = 0; j < cols; j++) {
          const cell = this.o.insert(row.id, prevCell, {});
          prevCell = cell.id;
          first = first || cell;
        }
      }
      return { id: first.id, off: 0 };
    });
  },

  addRow(id, below, focusCol = null) {
    const { table, rows, r, c, cols } = this.cellPos(id);
    this.op(() => {
      const ref = rows[r];
      const after = below ? ref.id : r > 0 ? rows[r - 1].id : null;
      const row = this.o.insert(table.id, after, {});
      let prev = null, target = null;
      const want = focusCol ?? c;
      for (let j = 0; j < cols; j++) {
        const cell = this.o.insert(row.id, prev, {});
        prev = cell.id;
        if (j === Math.min(want, cols - 1)) target = cell;
      }
      return { id: target.id, off: 0 };
    });
  },

  addCol(id, right) {
    const { table, rows, r, c } = this.cellPos(id);
    this.op(() => {
      const w = colWidths(table);
      if (w.some(Boolean)) {
        w.splice(right ? c + 1 : c, 0, 0);
        this.o.update(table.id, { cw: w.map((x) => x || '').join(',') });
      }
      let target = null;
      rows.forEach((row, i) => {
        const cells = this.o.children(row.id);
        let after;
        if (right) after = cells[Math.min(c, cells.length - 1)]?.id ?? null;
        else after = c > 0 ? (cells[Math.min(c - 1, cells.length - 1)]?.id ?? null) : null;
        const cell = this.o.insert(row.id, after, {});
        if (i === r) target = cell;
      });
      return { id: target.id, off: 0 };
    });
  },

  // Ctrl+D in a cell: copy the row below itself.
  duplicateRow(id) {
    const { rows, r, c } = this.cellPos(id);
    const off = this.caretOf(id);
    this.op(() => {
      const copy = this.o.copySubtree(rows[r].id, rows[r].p, rows[r].id);
      const cell = this.o.children(copy.id)[c];
      return cell ? { id: cell.id, off } : null;
    });
  },

  delRow(id) {
    const { table, rows, r, c } = this.cellPos(id);
    if (rows.length === 1) return this.deleteTable(table.id);
    this.op(() => {
      this.o.remove(rows[r].id);
      const nr = Math.min(r, rows.length - 2);
      const cells = this.o.children(this.o.children(table.id)[nr].id);
      const target = cells[Math.min(c, cells.length - 1)];
      return target ? { id: target.id, off: 'end' } : { id: table.id, off: 'end' };
    });
  },

  delCol(id) {
    const { table, rows, r, c, cols } = this.cellPos(id);
    if (cols === 1) return this.deleteTable(table.id);
    this.op(() => {
      const w = colWidths(table);
      if (w.some(Boolean)) {
        w.splice(c, 1);
        this.o.update(table.id, { cw: w.some(Boolean) ? w.map((x) => x || '').join(',') : '' });
      }
      for (const row of rows) {
        const cell = this.o.children(row.id)[c];
        if (cell) this.o.remove(cell.id);
      }
      const cells = this.o.children(rows[r].id);
      const target = cells[Math.min(c, cells.length - 1)];
      return target ? { id: target.id, off: 'end' } : { id: table.id, off: 'end' };
    });
  },

  deleteTable(tableId) {
    const t = this.o.get(tableId);
    if (!confirm(`Delete this table${t.t ? ` ("${t.t}")` : ''}? (Undo brings it back.)`)) return;
    // Focus the line just above the table afterwards.
    const all = [...this.main.querySelectorAll('.text')];
    const i = all.indexOf(this.textEl(tableId));
    const prev = all.slice(0, Math.max(i, 0)).reverse().find((el) => el.dataset.id)?.dataset.id;
    this.op(() => {
      this.o.remove(tableId);
      return prev && this.o.get(prev) ? { id: prev, off: 'end' } : null;
    });
  },

  // Ctrl+Shift+0..6: color every cell in the row (same color again clears).
  setRowColor(id, color) {
    const { rows, r } = this.cellPos(id);
    const off = this.caretOf(id);
    this.op(() => {
      const cells = this.o.children(rows[r].id);
      const next = cells.length && cells.every((x) => (x.cl || 0) === color) ? 0 : color;
      for (const x of cells) if ((x.cl || 0) !== next) this.o.update(x.id, { cl: next });
      return { id, off };
    });
  },

  // Toggle a table flag: hd (header row) or nb (no cell borders).
  toggleTableFlag(id, flag) {
    const { table } = this.cellPos(id);
    const off = this.caretOf(id);
    this.op(() => {
      this.o.update(table.id, { [flag]: !table[flag] });
      return { id, off };
    });
  },

  // ---------- column widths (drag a column's right edge) ----------

  bindTableResize() {
    const near = (e) => {
      const td = e.target.closest?.('#outline .tbl td');
      if (!td) return null;
      const d = td.getBoundingClientRect().right - e.clientX;
      const tol = e.pointerType === 'mouse' ? 5 : 12;
      return d >= -3 && d <= tol ? td : null;
    };
    this.main.addEventListener('pointermove', (e) => {
      if (!this.colDrag) this.main.classList.toggle('col-resize', !!near(e));
    });
    this.main.addEventListener('pointerdown', (e) => {
      const td = near(e);
      if (!td || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const table = td.closest('table');
      this.colDrag = {
        tableId: table.dataset.table,
        ci: td.cellIndex,
        col: table.querySelectorAll('col')[td.cellIndex],
        x0: e.clientX,
        w0: td.getBoundingClientRect().width,
        w: null,
      };
      document.body.classList.add('col-resizing');
    }, true);
    window.addEventListener('pointermove', (e) => {
      const d = this.colDrag;
      if (!d) return;
      d.w = Math.max(40, Math.round(d.w0 + e.clientX - d.x0));
      d.col.style.width = `${d.w}px`;
    });
    window.addEventListener('pointerup', () => {
      const d = this.colDrag;
      if (!d) return;
      this.colDrag = null;
      document.body.classList.remove('col-resizing');
      if (d.w !== null) this.setColWidth(d.tableId, d.ci, d.w);
    });
    this.main.addEventListener('dblclick', (e) => {
      const td = near(e);
      if (!td) return;
      e.preventDefault();
      this.setColWidth(td.closest('table').dataset.table, td.cellIndex, 0);
    });
  },

  setColWidth(tableId, ci, w) {
    const t = this.o.get(tableId);
    const widths = colWidths(t);
    while (widths.length <= ci) widths.push(0);
    widths[ci] = w;
    const cw = widths.some(Boolean) ? widths.map((x) => x || '').join(',') : '';
    if (cw === (t.cw || '')) return this.render();
    this.op(() => {
      this.o.update(tableId, { cw });
      return null;
    });
  },

  // ---------- table toolbar ----------

  showTableTools(cellEl) {
    const table = cellEl.closest('table');
    if (!table) return;
    this.toolsTable = table;
    this.tableTools.hidden = false;
    this.buildPinnedHeader();
    this.placeTableTools();
    if (!this.toolsTracking) {
      // Keep it in place while the page scrolls or resizes.
      this.toolsTracking = true;
      const follow = () => { if (!this.tableTools.hidden) this.placeTableTools(); };
      // Capture: also hears the table's own sideways scroll, not just the page's.
      window.addEventListener('scroll', follow, { passive: true, capture: true });
      window.addEventListener('resize', () => {
        if (this.tableTools.hidden) return;
        this.buildPinnedHeader();
        this.placeTableTools();
      });
      this.tableHead.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the cursor where it is
    }
  },

  // A fixed copy of the table's header row (same column widths), shown below
  // the toolbar once the real header row has scrolled under it. Being
  // position:fixed like the toolbar, it doesn't jitter while scrolling.
  buildPinnedHeader() {
    const t = this.toolsTable;
    const pin = this.tableHead;
    pin.innerHTML = '';
    pin.hidden = true;
    if (!t || !t.classList.contains('hd') || t.rows.length < 2) return;
    const row = t.rows[0];
    const copy = document.createElement('table');
    copy.className = t.className;
    copy.style.tableLayout = 'fixed';
    copy.style.width = `${t.getBoundingClientRect().width}px`;
    const tr = row.cloneNode(true);
    [...row.cells].forEach((td, i) => { tr.cells[i].style.width = `${td.getBoundingClientRect().width}px`; });
    for (const el of tr.querySelectorAll('[contenteditable]')) {
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-id');
      el.removeAttribute('data-new');
    }
    copy.createTBody().append(tr);
    pin.append(copy);
  },

  // Just above the table's first row; once that has scrolled under the
  // header, pinned right below the header. Hidden when the whole table is
  // above the screen.
  placeTableTools() {
    const tools = this.tableTools;
    const t = this.toolsTable;
    if (!t || !t.isConnected) { tools.hidden = true; return; }
    const r = t.getBoundingClientRect();
    const h = tools.offsetHeight || 34;
    const headerBottom = document.querySelector('header').getBoundingClientRect().bottom;
    const top = Math.max(r.top - h - 4, headerBottom + 4);
    tools.style.visibility = r.bottom < headerBottom + h ? 'hidden' : '';
    tools.style.top = `${top}px`;
    tools.style.left = `${Math.max(r.left, 8)}px`;

    // Pinned header copy: shown once the real header row has scrolled up to
    // the toolbar, until the table's last row reaches it. Its solid
    // background runs from the search bar down, filling the gap around the
    // toolbar so no text shows through.
    const pin = this.tableHead;
    const copy = pin.firstChild;
    if (!copy) return;
    const slot = top + h + 4; // where the header copy's top goes
    const copyH = copy.getBoundingClientRect().height;
    const lastRow = t.rows[t.rows.length - 1].getBoundingClientRect();
    if (r.top < slot && lastRow.top > slot + copyH) {
      const wrap = t.closest('.table-wrap').getBoundingClientRect();
      pin.hidden = false;
      pin.style.top = `${headerBottom}px`;
      pin.style.left = `${wrap.left}px`;
      pin.style.width = `${wrap.width}px`;
      pin.style.paddingTop = `${slot - headerBottom}px`;
      copy.style.marginLeft = `${r.left - wrap.left}px`;
    } else {
      pin.hidden = true;
    }
  },

  unpinHeader() {
    this.tableHead.hidden = true;
  },

  tableCommand(cmd, id) {
    if (!id || !this.o.isCell(id)) return;
    switch (cmd) {
      case 'row-above': return this.addRow(id, false);
      case 'row-below': return this.addRow(id, true);
      case 'col-left': return this.addCol(id, false);
      case 'col-right': return this.addCol(id, true);
      case 'del-row': return this.delRow(id);
      case 'del-col': return this.delCol(id);
      case 'del-table': return this.deleteTable(this.cellPos(id).table.id);
      case 'header': return this.toggleTableFlag(id, 'hd');
      case 'borders': return this.toggleTableFlag(id, 'nb');
    }
  },
};

// Column widths of a table node as numbers (0 = automatic).
function colWidths(t) {
  return (t.cw || '').split(',').map((x) => parseInt(x, 10) || 0);
}

function setCaretEnd(el, off) {
  const sel = getSelection();
  const r = document.createRange();
  const len = el.textContent.length;
  const target = off === 'end' || off == null ? len : Math.min(off, len);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = target, node;
  while ((node = walker.nextNode())) {
    if (hiddenMarker(node) && left <= node.length) { left = 0; continue; }
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
