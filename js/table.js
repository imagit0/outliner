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

const lastChildId = (o, pid) => {
  const k = o.children(pid);
  return k.length ? k[k.length - 1].id : null;
};

export const tableMethods = {
  // ---------- rendering ----------

  renderTable(t) {
    const rows = this.o.children(t.id);
    const cols = Math.max(1, ...rows.map((r) => this.o.children(r.id).length));
    let html = `<div class="table-wrap"><table class="tbl" data-table="${t.id}">`;
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
    const { rows, r, c } = this.cellPos(id);
    this.op(() => {
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

  // ---------- table toolbar ----------

  showTableTools(cellEl) {
    const tools = this.tableTools;
    const tableEl = cellEl.closest('table');
    if (!tableEl) return;
    tools.hidden = false;
    const r = tableEl.getBoundingClientRect();
    const h = tools.offsetHeight || 34;
    const top = Math.max(r.top - h - 4, 56); // stay below the header
    tools.style.top = `${top + window.scrollY}px`;
    tools.style.left = `${Math.max(r.left, 8) + window.scrollX}px`;
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
    }
  },
};

function setCaretEnd(el, off) {
  const sel = getSelection();
  const r = document.createRange();
  const len = el.textContent.length;
  const target = off === 'end' || off == null ? len : Math.min(off, len);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = target, node;
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
