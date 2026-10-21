// Markdown описаний замечаний: безопасный рендер в HTML (отчёт, редактор) и обратное преобразование
// HTML → Markdown (визуальный редактор, вставка из буфера). Поддерживается подмножество, которого хватает
// для описаний: заголовки, жирный/курсив/зачёркнутый, код, ссылки, списки (в т.ч. вложенные и чек-листы),
// цитаты, блоки кода, горизонтальная линия. Одиночный перенос строки — <br>, как в комментариях GitHub,
// поэтому старые описания простым текстом выглядят как раньше.
// Весь пользовательский текст экранируется, ссылки — только http(s) (safeHref).

import { safeHref } from './url.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Markdown → HTML ----------

const ESCAPABLE = /\\([\\`*_~[\]()#+\-.!>|{}])/g;
const WORD = /[\p{L}\p{N}]/u;

export function renderInline(text) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text ?? '').replace(/\u0000/g, '');
  s = s.replace(/\\`/g, () => keep('`')); // \` — обычный символ, а не начало кода
  // Код — до остальной разметки: внутри него она не работает.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
    const body = /^ .* $/s.test(code) && code.trim() ? code.slice(1, -1) : code;
    return keep(`<code>${esc(body)}</code>`);
  });
  s = s.replace(ESCAPABLE, (_, c) => keep(esc(c)));
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url);
    return href ? keep(`<a href="${esc(href)}" target="_blank" rel="noopener">`) + label + keep('</a>') : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]*[^\s<>\u0000.,:;"')\]!?])/g, (m, before, url) => {
    const href = safeHref(url);
    return href ? before + keep(`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(url)}</a>`) : m;
  });
  s = esc(s);
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])/gu, (m, inner, off, str) => (WORD.test(str[off - 1] || '') ? m : `<strong>${inner}</strong>`));
  s = s.replace(/(?<!\*)\*(?![\s*])([^*]*?[^\s*])\*(?!\*)/g, (m, inner) => (balanced(inner) ? `<em>${inner}</em>` : m));
  // _курсив_ — только на границах слов: в селекторах вида flex_module_x подчёркивания остаются как есть.
  s = s.replace(/(?<![\p{L}\p{N}_])_(?![\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, (m, inner) => (balanced(inner) ? `<em>${inner}</em>` : m));
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

// Курсив не должен разрывать <strong>/<del>, вставленные раньше.
function balanced(html) {
  for (const tag of ['strong', 'del', 'em']) {
    if ((html.match(new RegExp(`<${tag}>`, 'g')) || []).length !== (html.match(new RegExp(`</${tag}>`, 'g')) || []).length) return false;
  }
  return true;
}

const RE = {
  fence: /^\s{0,3}(```|~~~)(.*)$/,
  hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  quote: /^\s{0,3}>\s?(.*)$/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  emptyItem: /^(\s*)([-*+]|\d{1,9}[.)])$/,
};

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(lines);
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  const isStart = (line) => RE.fence.test(line) || RE.hr.test(line) || RE.heading.test(line) || RE.quote.test(line) || RE.item.test(line) || RE.emptyItem.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(RE.fence);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i]); i++) body.push(lines[i]);
      i++;
      const lang = langOf(fence[2]);
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (RE.hr.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    const h = line.match(RE.heading);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const body = [];
      for (; i < lines.length && lines[i].trim() && RE.quote.test(lines[i]); i++) body.push(lines[i].match(RE.quote)[1]);
      out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }
    if (RE.item.test(line) || RE.emptyItem.test(line)) {
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        const m = l.match(RE.item) || l.match(RE.emptyItem);
        if (m) {
          items.push(listItem(indentOf(l), m[2], m[3] || ''));
        } else if (l.trim() && indentOf(l) > 0 && items.length) {
          items[items.length - 1].text += `\n${l.trim()}`; // продолжение пункта — строка с отступом
        } else if (!l.trim() && i + 1 < lines.length && (RE.item.test(lines[i + 1]) || (lines[i + 1].trim() && indentOf(lines[i + 1]) > 0))) {
          continue; // пустая строка внутри списка
        } else break;
      }
      out.push(renderList(items));
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && (para.length === 0 || !isStart(lines[i])); i++) para.push(lines[i].trim());
    out.push(`<p>${renderInline(para.join('\n'))}</p>`);
  }
  return out.join('');
}

// Язык блока кода (```python): только безопасное короткое имя, иначе без языка.
const langOf = (info) => (String(info || '').trim().split(/\s+/)[0].match(/^[\w+#.-]{1,20}$/) || [''])[0];

function listItem(indent, marker, text) {
  const ordered = /\d/.test(marker);
  const task = !ordered && text.match(/^\[([ xX])\](?:\s+|$)(.*)$/s);
  return { indent, ordered, start: ordered ? parseInt(marker, 10) : 1, task: task ? task[1] !== ' ' : null, text: task ? task[2] : text };
}

function renderList(items) {
  let html = '';
  let i = 0;
  while (i < items.length) {
    const { indent, ordered, start } = items[i];
    const tasks = !ordered && items[i].task !== null;
    let body = '';
    while (i < items.length && items[i].indent === indent && items[i].ordered === ordered && (ordered || (items[i].task !== null) === tasks)) {
      const it = items[i++];
      const kids = [];
      while (i < items.length && items[i].indent > indent) kids.push(items[i++]);
      const nested = kids.length ? renderList(kids) : '';
      body += tasks
        ? `<li class="todo" data-checked="${it.task}">${renderInline(it.text)}${nested}</li>`
        : `<li>${renderInline(it.text)}${nested}</li>`;
    }
    html += ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul${tasks ? ' class="todos"' : ''}>${body}</ul>`;
    // Пункт с меньшим отступом, чем у первого в группе, начинает новый список того же уровня.
    if (i < items.length && items[i].indent < indent) items[i].indent = indent;
  }
  return html;
}

// ---------- HTML → Markdown ----------

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'LI', 'FIGURE']);
const isBlock = (n) => n.nodeType === 1 && BLOCK.has(n.tagName);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'IMG', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

const isWordChar = (c) => !!c && WORD.test(c);
function escapeText(text) {
  return text
    .replace(/[\\`*~[\]]/g, '\\$&')
    .replace(/_/g, (m, off, str) => (isWordChar(str[off - 1]) && isWordChar(str[off + 1]) ? '_' : '\\_'));
}

// Строка не должна случайно стать заголовком, списком, цитатой или линией.
function escapeLineStart(line) {
  return line.replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|(?:-\s*){3,}$|\d{1,9}(?=[.)](?:\s|$)))/, (m, sp, mark) =>
    /^\d/.test(mark) ? `${sp}${mark}\\` : `${sp}\\${mark}`,
  );
}

function wrap(mark, inner, closeMark = mark) {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${closeMark}${m[3]}` : inner;
}

const fontWeightBold = (el) => /^(bold|[6-9]00)$/.test(el.style?.fontWeight || '');
const fontItalic = (el) => (el.style?.fontStyle || '') === 'italic';
const struck = (el) => /line-through/.test(el.style?.textDecoration || el.style?.textDecorationLine || '');

function inlineOf(nodes) {
  let out = '';
  for (const n of nodes) out += inlineNode(n);
  return out;
}

function inlineNode(n) {
  if (n.nodeType === 3) return escapeText(n.nodeValue.replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/[\n\r\t]+/g, ' '));
  if (n.nodeType !== 1 || SKIP.has(n.tagName)) return '';
  const tag = n.tagName;
  if (tag === 'BR') return '\n';
  if (isBlock(n)) return blocksOf(n).join('\n');
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
    const text = n.textContent.replace(/\u200B/g, '').replace(/\u00A0/g, ' ');
    if (!text) return '';
    const ticks = '`'.repeat(Math.max(1, ...(text.match(/`+/g) || ['']).map((t) => t.length + 1)));
    const pad = /^`|`$/.test(text) || ticks.length > 1 ? ' ' : '';
    return `${ticks}${pad}${text}${pad}${ticks}`;
  }
  let inner = inlineOf(n.childNodes);
  if (tag === 'A') {
    const href = safeHref(n.getAttribute('href'));
    if (!href) return inner;
    const label = inner.trim();
    if (!label || label === escapeText(href)) return href;
    return `[${label.replace(/\n/g, ' ')}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  }
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || struck(n)) inner = wrap('~~', inner);
  if (tag === 'I' || tag === 'EM' || fontItalic(n)) inner = wrap('_', inner);
  if (tag === 'B' || tag === 'STRONG' || fontWeightBold(n)) inner = wrap('**', inner);
  return inner;
}

// Склеивает строки абзаца: убирает лишние пробелы по краям, экранирует начало строк.
function paragraph(text) {
  return text
    .split('\n')
    .map((l) => escapeLineStart(l.replace(/ +/g, ' ').trim()))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function blocksOf(parent) {
  const out = [];
  let run = [];
  const flush = () => {
    const text = paragraph(inlineOf(run));
    if (text.trim()) out.push(text);
    run = [];
  };
  let prevQuote = false;
  for (const n of parent.childNodes) {
    if (isBlock(n)) {
      flush();
      const b = blockOf(n);
      if (!b || !b.trim()) continue;
      // Соседние <blockquote> (так редактор делит цитату на строки) — одна цитата.
      const quote = n.tagName === 'BLOCKQUOTE';
      if (quote && prevQuote) out[out.length - 1] += `\n${b}`;
      else out.push(b);
      prevQuote = quote;
    } else {
      if (n.nodeType === 1 || n.nodeValue.trim()) prevQuote = false;
      run.push(n);
    }
  }
  flush();
  return out;
}

function blockOf(n) {
  const tag = n.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = inlineOf(n.childNodes).replace(/\s*\n\s*/g, ' ').trim();
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
  }
  if (tag === 'HR') return '---';
  if (tag === 'PRE') {
    const code = preText(n).replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/\n+$/, '');
    return code.trim() ? `\`\`\`${langOf(n.getAttribute('data-lang'))}\n${code.replace(/^```/gm, '\\```')}\n\`\`\`` : '';
  }
  if (tag === 'UL' || tag === 'OL') return listOf(n, 0);
  if (tag === 'BLOCKQUOTE') {
    const inner = blocksOf(n).join('\n\n');
    return inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
  }
  if (tag === 'LI') return listOf({ tagName: 'UL', children: [n], getAttribute: () => null, classList: { contains: () => false } }, 0);
  return blocksOf(n).join('\n\n');
}

// Текст блока кода: из редактора приходят переносы и через \n, и через <br>.
function preText(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeName === 'BR') out += '\n';
    else if (n.nodeType === 1) out += (/^(DIV|P)$/.test(n.nodeName) && out && !out.endsWith('\n') ? '\n' : '') + preText(n);
  }
  return out;
}

function listOf(list, depth) {
  const ordered = list.tagName === 'OL';
  let k = Number(list.getAttribute('start')) || 1;
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const li of list.children) {
    if (li.tagName === 'UL' || li.tagName === 'OL') {
      lines.push(listOf(li, depth + 1)); // список прямо внутри списка (так делает contenteditable)
      continue;
    }
    if (li.tagName !== 'LI') continue;
    const checked = li.getAttribute('data-checked');
    const task = checked !== null && checked !== undefined && !ordered ? `[${checked === 'true' ? 'x' : ' '}] ` : '';
    const marker = ordered ? `${k++}. ` : '- ';
    const own = [];
    const nested = [];
    for (const c of li.childNodes) (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL') ? nested : own).push(c);
    const text = own
      .map((c) => (isBlock(c) ? blocksOf(c).join('\n') : inlineNode(c)))
      .join('')
      .split('\n')
      .map((l) => l.replace(/ +/g, ' ').trim())
      .filter((l, idx, arr) => l || (idx > 0 && idx < arr.length - 1))
      .join(`\n${pad}  `);
    if (!text && !nested.length) continue; // пустой пункт (курсор в редакторе) в Markdown не попадает
    lines.push(`${pad}${marker}${task}${text}`.replace(/\s+$/, ''));
    for (const sub of nested) lines.push(listOf(sub, depth + 1));
  }
  return lines.join('\n');
}

// root — элемент или фрагмент. Возвращает Markdown без лишних пустых строк по краям.
export function htmlToMarkdown(root) {
  return blocksOf(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Произвольный HTML (например, из буфера обмена) → безопасный HTML редактора: через Markdown,
// поэтому остаётся только то, что умеет описание.
export function sanitizeHtml(html, doc) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  return renderMarkdown(htmlToMarkdown(tpl.content));
}
