// Small popup menu, used for the sidebar's ⋯ buttons and right-click menus.
//
// open(items, x, y) where items are:
//   { label, run, danger?, hint? }       a command
//   'sep'                                a separator line
//   { swatches: [values], run(value) }   a row of color dots (value 0 = clear)
//   { buttons: [{ label, value, title }], run(value) }   a row of small buttons
// Closes on a choice, Esc, outside click, scroll or resize. Pressing on the
// menu never takes focus away from the line being edited.

import { esc } from './format.js';

export class Menu {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'ctx-menu';
    this.el.setAttribute('role', 'menu');
    this.el.hidden = true;
    document.body.append(this.el);

    this.el.addEventListener('pointerdown', (e) => e.preventDefault());
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const item = this.items[+b.dataset.i];
      this.close();
      item.run(b.dataset.v === undefined ? undefined : Number(b.dataset.v));
    });
    document.addEventListener('pointerdown', (e) => { if (!this.el.hidden && !this.el.contains(e.target)) this.close(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.el.hidden) { e.preventDefault(); this.close(); } }, true);
    window.addEventListener('scroll', () => this.close(), { passive: true, capture: true });
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }

  get isOpen() { return !this.el.hidden; }

  open(items, x, y) {
    this.items = items;
    this.el.innerHTML = items.map((it, i) => {
      if (it === 'sep') return '<hr>';
      if (it.swatches) {
        return `<div class="m-row">` + it.swatches.map((v) =>
          `<button type="button" class="sw ${v ? `cl-${v}` : 'none'}" data-i="${i}" data-v="${v}" title="${v ? 'Color' : 'No color'}">${v ? '' : '✕'}</button>`).join('') + `</div>`;
      }
      if (it.buttons) {
        return `<div class="m-row">` + it.buttons.map((b) =>
          `<button type="button" class="fb" data-i="${i}" data-v="${b.value}" title="${esc(b.title || '')}">${b.label}</button>`).join('') + `</div>`;
      }
      return `<button type="button" class="m-item${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}">` +
        `<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
    }).join('');
    this.el.hidden = false;
    // Keep it on screen.
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    this.el.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
    this.el.style.top = `${Math.max(4, y + h > innerHeight - 4 ? y - h : y)}px`;
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.closedAt = Date.now();
  }
}
