// Inline formatting for item text (Dynalist style): `code`, **bold**,
// __italic__, [link text](url) and bare links.
//
// The produced HTML always has exactly the raw text as its textContent: the
// markup characters are kept in <span class="md"> elements that CSS hides
// unless the item is being edited. That way caret offsets mean the same thing
// whether or not an item is formatted, and editing never has to swap DOM.

const RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|\[([^\]\n]+)\]\(([^\s()]+)\)|(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"])/g;

// Links without a scheme ("example.com") open as https.
export const linkHref = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const md = (s) => `<span class="md">${s}</span>`;

export function format(text) {
  if (!text) return '';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(RE)) {
    out += esc(text.slice(last, m.index));
    const [s, code, bold, ital, label, target, url] = m;
    if (code) out += md('`') + `<code>${esc(code.slice(1, -1))}</code>` + md('`');
    else if (bold) out += md('**') + `<b>${esc(bold.slice(2, -2))}</b>` + md('**');
    else if (ital) out += md('__') + `<i>${esc(ital.slice(2, -2))}</i>` + md('__');
    else if (label) out += md('[') + `<span class="link" data-href="${esc(linkHref(target))}">${esc(label)}</span>` + md(`](${esc(target)})`);
    else if (url) out += `<span class="link" data-href="${esc(url)}">${esc(url)}</span>`;
    last = m.index + s.length;
  }
  return out + esc(text.slice(last));
}
