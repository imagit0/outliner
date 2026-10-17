// Inline formatting for item text (Dynalist style): `code`, **bold**,
// __italic__, ~~strikethrough~~, ==highlight==, [link text](url), bare links,
// and image links: ![caption](url) or !https://… (preview pops up on hover).
//
// The produced HTML always has exactly the raw text as its textContent: the
// markup characters are kept in <span class="md"> elements that CSS hides
// unless the item is being edited. That way caret offsets mean the same thing
// whether or not an item is formatted, and editing never has to swap DOM.

const URL_RE = String.raw`https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"]`;
const RE = new RegExp(
  [
    String.raw`!\[([^\]\n]*)\]\(([^\s()]+)\)`, // 1,2  ![caption](url)
    `!(${URL_RE})`, //                           3    !https://…
    '(`[^`\\n]+`)', //                           4    `code`
    String.raw`(\*\*[^*\n]+\*\*)`, //            5    **bold**
    '(__[^_\\n]+__)', //                         6    __italic__
    '(~~[^~\\n]+~~)', //                         7    ~~strike~~
    '(==[^=\\n]+==)', //                         8    ==highlight==
    String.raw`\[([^\]\n]+)\]\(([^\s()]+)\)`, // 9,10 [text](url)
    `(${URL_RE})`, //                            11   https://…
  ].join('|'),
  'g',
);

// Links without a scheme ("example.com") open as https.
export const linkHref = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const md = (s) => `<span class="md">${esc(s)}</span>`;
const link = (href, inner, cls = '') =>
  `<span class="link${cls}" data-href="${esc(href)}">${inner}</span>`;
const wrap = (mark, tag, s) => md(mark) + `<${tag}>${esc(s.slice(mark.length, -mark.length))}</${tag}>` + md(mark);

export function format(text) {
  if (!text) return '';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(RE)) {
    out += esc(text.slice(last, m.index));
    const [s, imgCap, imgUrl, imgBare, code, bold, ital, strike, high, label, target, url] = m;
    // Image links show as an "Image" chip; the URL is only visible while editing.
    if (imgUrl !== undefined) out += md('![') + link(linkHref(imgUrl), esc(imgCap), ' img') + md(`](${imgUrl})`);
    else if (imgBare) out += md('!') + link(imgBare, md(imgBare), ' img bare');
    else if (code) out += md('`') + `<code>${esc(code.slice(1, -1))}</code>` + md('`');
    else if (bold) out += wrap('**', 'b', bold);
    else if (ital) out += wrap('__', 'i', ital);
    else if (strike) out += wrap('~~', 's', strike);
    else if (high) out += wrap('==', 'mark', high);
    else if (label) out += md('[') + link(linkHref(target), esc(label)) + md(`](${target})`);
    else if (url) out += link(url, esc(url));
    last = m.index + s.length;
  }
  return out + esc(text.slice(last));
}
