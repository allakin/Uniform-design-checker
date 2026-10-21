// Редактор описания замечания: визуальный режим (contenteditable) и режим Markdown (textarea).
// Значение — всегда Markdown: его хранит store, из него собирается отчёт.
// В визуальном режиме работают привычные сокращения Markdown: «# » — заголовок, «- » — список,
// «1. » — нумерованный, «[] » — чек-лист, «> » — цитата, «```» — блок кода; **жирный**, _курсив_, ~~зачёркнутый~~, `код`.
import { renderMarkdown, htmlToMarkdown, sanitizeHtml } from '../lib/markdown.js';
import { escapeHtml } from '../lib/report.js';
import { icon } from '../lib/icons.js';

const MODE_KEY = 'udc-md-mode'; // 'visual' | 'source' — общий для всех карточек
const editors = new Set(); // смонтированные редакторы: режим переключается у всех сразу
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl+';

const TOOLS = [
  ['bold', 'bold', `Жирный (${MOD}B)`],
  ['italic', 'italic', `Курсив (${MOD}I)`],
  ['strike', 'strikethrough', 'Зачёркнутый'],
  ['code', 'code', 'Код'],
  ['link', 'link', `Ссылка (${MOD}K)`],
  '|',
  ['heading', 'heading', 'Заголовок'],
  ['ul', 'listUl', 'Маркированный список'],
  ['ol', 'listOl', 'Нумерованный список'],
  ['task', 'listCheck', 'Чек-лист'],
  ['quote', 'quote', 'Цитата'],
  ['hr', 'minus', 'Разделитель'],
];

function getMode(remember) {
  if (!remember) return 'visual';
  try {
    return window.localStorage.getItem(MODE_KEY) === 'source' ? 'source' : 'visual';
  } catch {
    return 'visual';
  }
}

export function editorHtml({ placeholder = '' } = {}) {
  const tools = TOOLS.map((t) =>
    t === '|' ? '<span class="md-sep"></span>' : `<button type="button" class="md-tool" data-cmd="${t[0]}" title="${escapeHtml(t[2])}" aria-label="${escapeHtml(t[2])}">${icon(t[1], 15)}</button>`,
  ).join('');
  return `
    <div class="md-ed" data-md>
      <div class="md-toolbar" role="toolbar">
        ${tools}
        <span class="md-spacer"></span>
        <button type="button" class="md-mode" data-cmd="mode" title="Переключить: визуальный редактор / разметка Markdown">${icon('markdown', 16)}<span>Markdown</span></button>
      </div>
      <div class="md-visual md" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true" data-field="description-visual" data-placeholder="${escapeHtml(placeholder)}"></div>
      <textarea class="md-source" data-field="description" placeholder="${escapeHtml(placeholder)}" spellcheck="true"></textarea>
    </div>`;
}

// root — элемент .md-ed из editorHtml. onChange(markdown) — при каждом изменении.
// askLink(currentUrl) → Promise<string|null> — запрос адреса ссылки (диалог страницы).
// rememberMode=false — не читать и не сохранять режим в localStorage: на сайте (контент-скрипт) это хранилище сайта.
export function mountEditor(root, { value = '', onChange = () => {}, askLink = async () => null, rememberMode = true } = {}) {
  const visual = root.querySelector('.md-visual');
  const source = root.querySelector('.md-source');
  const modeBtn = root.querySelector('[data-cmd=mode]');
  source.value = value;
  visual.innerHTML = renderMarkdown(value);

  const setEmpty = () => visual.classList.toggle('is-empty', !visual.textContent.trim() && !visual.querySelector('hr, li'));
  const applyMode = (mode) => {
    root.dataset.mode = mode;
    visual.hidden = mode !== 'visual';
    source.hidden = mode !== 'source';
    modeBtn.setAttribute('aria-pressed', String(mode === 'source'));
  };
  applyMode(getMode(rememberMode));
  setEmpty();

  let last = value;
  const emit = (md) => {
    if (md === last) return;
    last = md;
    onChange(md);
  };
  const syncFromVisual = () => {
    setEmpty();
    const md = htmlToMarkdown(visual);
    source.value = md;
    emit(md);
  };
  source.addEventListener('input', () => emit(source.value));

  // ---------- Режимы ----------
  modeBtn.addEventListener('click', () => {
    const next = root.dataset.mode === 'source' ? 'visual' : 'source';
    if (next === 'visual') {
      visual.innerHTML = renderMarkdown(source.value);
      setEmpty();
    } else source.value = htmlToMarkdown(visual);
    if (rememberMode) {
      try {
        window.localStorage.setItem(MODE_KEY, next);
      } catch {}
    }
    applyMode(next);
    // Остальные карточки переключаются вместе с этой; карточки, убранные со страницы при перерисовке, забываем.
    for (const other of editors) {
      if (!other.root.isConnected) editors.delete(other);
      else if (other.root !== root) other.switchTo(next);
    }
    (next === 'visual' ? visual : source).focus();
  });
  editors.add({
    root,
    switchTo(mode) {
      if (mode === root.dataset.mode) return;
      if (mode === 'visual') {
        visual.innerHTML = renderMarkdown(source.value);
        setEmpty();
      } else source.value = htmlToMarkdown(visual);
      applyMode(mode);
    },
  });

  // ---------- Визуальный режим ----------
  const exec = (cmd, arg = null) => document.execCommand(cmd, false, arg);
  const getSel = () => selectionOf(visual);
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {}

  const selRange = () => {
    const sel = getSel();
    return sel.rangeCount && visual.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
  };
  const closestIn = (node, selector) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    const found = el?.closest(selector);
    return found && visual.contains(found) ? found : null;
  };
  const currentBlock = () => {
    const r = selRange();
    const block = r ? closestIn(r.startContainer, 'p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote') : null;
    return block === visual ? null : block;
  };
  // Строка без обёртки (текст прямо в редакторе) → абзац: иначе сокращения и кнопки не находят блок.
  // Оборачиваем вручную: formatBlock внутри обработчика ввода давал <p><ul>…</ul></p>.
  const BLOCKS = /^(P|DIV|H[1-6]|UL|OL|LI|PRE|BLOCKQUOTE|HR)$/;
  const ensureParagraph = () => {
    const r = selRange();
    if (!r || currentBlock()) return;
    const { startContainer: node, startOffset: offset } = r;
    let top = node === visual ? visual.childNodes[offset] || null : node;
    while (top && top.parentNode !== visual) top = top.parentNode;
    const p = document.createElement('p');
    if (!top || BLOCKS.test(top.nodeName)) {
      p.innerHTML = '<br>';
      visual.insertBefore(p, top);
      placeCaretAtEnd(p);
      return;
    }
    const inline = (x) => x && !BLOCKS.test(x.nodeName) && x.nodeName !== 'BR';
    let first = top;
    while (inline(first.previousSibling)) first = first.previousSibling;
    let last = top;
    while (inline(last.nextSibling)) last = last.nextSibling;
    if (last.nextSibling?.nodeName === 'BR') last = last.nextSibling;
    first.before(p);
    for (let n = first, stop = last.nextSibling; n && n !== stop; ) {
      const next = n.nextSibling;
      p.append(n);
      n = next;
    }
    const caret = document.createRange();
    caret.setStart(node, offset);
    caret.collapse(true);
    const sel = getSel();
    sel.removeAllRanges();
    sel.addRange(caret);
  };
  // Пустой редактор при фокусе — сразу с абзацем, чтобы первая строка не была «голым» текстом.
  visual.addEventListener('focus', () => {
    if (visual.childNodes.length) return;
    visual.innerHTML = '<p><br></p>';
    placeCaretAtEnd(visual.firstChild);
  });
  // Элемент-обёртку заменяем его содержимым (снять цитату, блок кода и т.п.).
  const unwrap = (el) => {
    const p = document.createElement('p');
    p.innerHTML = el.tagName === 'PRE' ? escapeHtml(el.textContent).replace(/\n/g, '<br>') : el.innerHTML;
    if (el.tagName === 'BLOCKQUOTE' && el.querySelector('p')) el.replaceWith(...el.childNodes);
    else el.replaceWith(p);
  };
  // Вставка inline-элемента вместо диапазона и курсор после него (за ним — невидимый пробел, иначе
  // браузер продолжит печатать внутри <code>/<strong>). Невидимый символ в Markdown не попадает.
  const placeInline = (range, el) => {
    range.deleteContents();
    range.insertNode(el);
    const after = document.createTextNode('\u200B');
    el.after(after);
    const sel = getSel();
    const r = document.createRange();
    r.setStart(after, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  // Списки собираем и разбираем сами, без insertUnorderedList: из обработчика ввода Chrome оставлял
  // список внутри абзаца (<p><ul>…</ul></p>), а такой Markdown уже не собрать.
  const LIST_TAG = { ul: 'UL', task: 'UL', ol: 'OL' };
  const kindOf = (list) => (list.tagName === 'OL' ? 'ol' : list.classList.contains('todos') ? 'task' : 'ul');
  const makeList = (kind) => {
    const list = document.createElement(LIST_TAG[kind]);
    if (kind === 'task') list.className = 'todos';
    return list;
  };
  const markItem = (li, kind) => {
    if (kind === 'task') {
      li.classList.add('todo');
      if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
    } else {
      li.classList.remove('todo');
      li.removeAttribute('data-checked');
      if (!li.classList.length) li.removeAttribute('class');
    }
  };
  // Курсор переживает перенос узлов, пока его текстовый узел остаётся в документе.
  const keepCaret = (fn) => {
    const r = selRange();
    const at = r && [r.startContainer, r.startOffset];
    const result = fn();
    if (at && at[0].isConnected && visual.contains(at[0])) {
      const caret = document.createRange();
      caret.setStart(at[0], Math.min(at[1], at[0].nodeType === 3 ? at[0].length : at[0].childNodes.length));
      caret.collapse(true);
      getSel().removeAllRanges();
      getSel().addRange(caret);
    } else if (result?.isConnected) placeCaretAtEnd(result);
    return result;
  };

  function blockToList(block, kind) {
    const li = document.createElement('li');
    markItem(li, kind);
    while (block.firstChild) li.append(block.firstChild);
    if (!li.childNodes.length) li.innerHTML = '<br>';
    const prev = block.previousElementSibling;
    if (prev && /^(UL|OL)$/.test(prev.tagName) && kindOf(prev) === kind) {
      prev.append(li);
      block.remove();
    } else {
      const list = makeList(kind);
      list.append(li);
      block.replaceWith(list);
    }
    return li;
  }

  function listItemToBlock(li) {
    const list = li.parentElement;
    const p = document.createElement('p');
    const nested = [];
    for (const n of [...li.childNodes]) {
      if (n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName)) nested.push(n);
      else p.append(n);
    }
    if (!p.textContent.replace(/\u200B/g, '') && !p.querySelector('br')) p.innerHTML = '<br>';
    const rest = [];
    for (let n = li.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    list.after(p);
    let tail = p;
    for (const sub of nested) {
      tail.after(sub);
      tail = sub;
    }
    if (rest.length) {
      const more = list.cloneNode(false);
      if (list.tagName === 'OL') more.setAttribute('start', String((Number(list.getAttribute('start')) || 1) + [...list.children].indexOf(li) + 1));
      more.append(...rest);
      tail.after(more);
    }
    li.remove();
    if (!list.children.length) list.remove();
    return p;
  }

  function toggleList(kind) {
    const r = selRange();
    if (!r) return;
    const li = closestIn(r.startContainer, 'li');
    if (li) {
      const list = li.parentElement;
      if (kindOf(list) === kind) return keepCaret(() => listItemToBlock(li));
      // Другой вид списка: меняем весь список целиком.
      return keepCaret(() => {
        let target = list;
        if (LIST_TAG[kind] !== list.tagName) {
          target = makeList(kind);
          target.append(...list.childNodes);
          list.replaceWith(target);
        } else target.classList.toggle('todos', kind === 'task');
        for (const item of target.children) if (item.tagName === 'LI') markItem(item, kind);
        return target;
      });
    }
    ensureParagraph();
    const range = selRange();
    // Все строки выделения (кнопка на панели), а для курсора — текущая.
    const blocks = [...visual.children].filter((b) => /^(P|DIV|H[1-6])$/.test(b.tagName) && range.intersectsNode(b));
    if (!blocks.length && currentBlock()) blocks.push(currentBlock());
    keepCaret(() => blocks.reduce((_, b) => blockToList(b, kind), null));
  }

  function toggleBlock(tag) {
    const block = currentBlock();
    const wrapper = closestIn(block, tag);
    if (wrapper) {
      if (tag === 'blockquote' || tag === 'pre') unwrap(wrapper);
      else exec('formatBlock', 'p');
    } else exec('formatBlock', tag);
  }

  function toggleCode() {
    const range = selRange();
    if (!range) return;
    const code = closestIn(range.startContainer, 'code');
    if (code && !closestIn(code, 'pre')) {
      code.replaceWith(document.createTextNode(code.textContent));
      return;
    }
    const el = document.createElement('code');
    el.textContent = range.toString() || 'код';
    placeInline(range, el);
  }

  async function makeLink() {
    const range = selRange();
    if (!range) return;
    const saved = range.cloneRange();
    const existing = closestIn(range.startContainer, 'a');
    const url = await askLink(existing?.getAttribute('href') || '');
    visual.focus();
    const sel = getSel();
    sel.removeAllRanges();
    sel.addRange(saved);
    if (url === null) return;
    if (!url) {
      if (existing) existing.replaceWith(...existing.childNodes);
      else exec('unlink');
    } else if (existing) existing.setAttribute('href', url);
    else if (saved.collapsed) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      placeInline(saved, a);
    } else exec('createLink', url);
    syncFromVisual();
  }

  const commands = {
    bold: () => exec('bold'),
    italic: () => exec('italic'),
    strike: () => exec('strikeThrough'),
    code: toggleCode,
    link: makeLink,
    heading: () => toggleBlock('h3'),
    ul: () => toggleList('ul'),
    ol: () => toggleList('ol'),
    task: () => toggleList('task'),
    quote: () => toggleBlock('blockquote'),
    hr: () => exec('insertHorizontalRule'),
  };

  root.querySelector('.md-toolbar').addEventListener('mousedown', (e) => {
    if (e.target.closest('.md-tool')) e.preventDefault(); // не забираем фокус и выделение у текста
  });
  root.querySelectorAll('.md-tool').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      if (root.dataset.mode === 'source') {
        sourceCommand(source, cmd);
        emit(source.value);
        return;
      }
      if (!selRange()) {
        visual.focus();
        placeCaretAtEnd(visual);
      }
      await commands[cmd]();
      syncFromVisual();
    }),
  );

  // Контент-скрипт перехватывает клавиатуру раньше редактора (чтобы не срабатывали горячие клавиши сайта)
  // и передаёт нажатия сам — через handleKeydown.
  visual.addEventListener('keydown', onKeydown);
  function onKeydown(e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      makeLink();
    }
    // Enter в пустом пункте списка, пустой строке цитаты или после пустой строки кода — выход из блока.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const block = currentBlock();
      const empty = (el) => !el.textContent.replace(/[\u200B\u00A0\s]/g, '');
      const li = closestIn(block, 'li');
      if (li && empty(li) && !li.querySelector('ul, ol')) {
        e.preventDefault();
        const list = li.parentElement;
        if (list.parentElement?.closest('li') && visual.contains(list.parentElement)) exec('outdent');
        else placeCaretAtEnd(listItemToBlock(li));
        syncFromVisual();
        return;
      }
      // Цитата: Chrome делает каждую строку отдельным <blockquote> (или <p> внутри него). Пустая строка — выход.
      const quote = closestIn(block, 'blockquote');
      if (quote && empty(block) && (block === quote || block === quote.lastElementChild)) {
        e.preventDefault();
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        if (block === quote) quote.replaceWith(p);
        else {
          quote.after(p);
          block.remove();
        }
        placeCaretAtEnd(p);
        syncFromVisual();
        return;
      }
      // В блоке кода Chrome переносит строку через <br>; Enter на пустой последней строке — выход из блока.
      const pre = closestIn(block, 'pre');
      const r = selRange();
      if (pre && r) {
        const head = document.createRange();
        head.setStart(pre, 0);
        head.setEnd(r.startContainer, r.startOffset);
        const tail = document.createRange();
        tail.setStart(r.endContainer, r.endOffset);
        tail.setEnd(pre, pre.childNodes.length);
        if (/\n$/.test(preText(head.cloneContents())) && !preText(tail.cloneContents()).trim()) {
          e.preventDefault();
          tail.deleteContents();
          while (pre.lastChild && (pre.lastChild.nodeName === 'BR' || !pre.lastChild.textContent.replace(/\n/g, ''))) pre.lastChild.remove();
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          pre.after(p);
          placeCaretAtEnd(p);
          syncFromVisual();
        }
      }
    }
  }

  // Клик по квадратику чек-листа (он нарисован слева от текста пункта) — отметить/снять.
  visual.addEventListener('mousedown', (e) => {
    const li = e.target.closest?.('li.todo');
    if (!li || !visual.contains(li)) return;
    if (e.clientX - li.getBoundingClientRect().left > 22) return;
    e.preventDefault();
    li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
    syncFromVisual();
  });

  visual.addEventListener('input', (e) => {
    if (e.inputType === 'insertText' && e.data) markdownShortcuts(e.data);
    syncFromVisual();
  });

  function markdownShortcuts(typed) {
    if (typed === ' ') ensureParagraph(); // до чтения позиции: formatBlock пересоздаёт текстовые узлы
    const range = selRange();
    if (!range || !range.collapsed) return;
    const node = range.startContainer;
    if (node.nodeType !== 3 || closestIn(node, 'pre, code')) return;
    const before = node.nodeValue.slice(0, range.startOffset);

    // Блочные — пробел после маркера в начале строки. Сначала меняем блок (пока в нём есть текст — иначе
    // Chrome не применяет formatBlock/insertList к пустой строке), потом убираем маркер.
    if (typed === ' ') {
      const block = currentBlock();
      const atStart = block && blockTextBefore(block, node, range.startOffset);
      if (!atStart) return;
      const marker = atStart.replace(/\u200B/g, '').replace(/\u00A0/g, ' ').trimStart();
      const inLi = !!closestIn(node, 'li');
      const actions = [
        // [шаблон, действие, можно ли внутри пункта списка]
        [/^(#{1,3}) $/, (m) => exec('formatBlock', `h${m[1].length}`)],
        [/^[-*+] $/, () => toggleList('ul')],
        [/^\d+[.)] $/, () => toggleList('ol')],
        [/^\[[ xX]?\] $/, (m) => {
          const li = closestIn(node, 'li');
          if (li?.parentElement.tagName === 'UL') {
            li.parentElement.classList.add('todos');
            li.classList.add('todo');
            li.setAttribute('data-checked', String(/x/i.test(m[0])));
          } else toggleList('task');
        }, true],
        [/^> $/, () => exec('formatBlock', 'blockquote')],
        [/^```\s?$/, () => exec('formatBlock', 'pre')],
      ];
      if (/^(-{3,}|\*{3,}|_{3,}) $/.test(marker) && !inLi) {
        deleteBefore(node, range.startOffset, atStart.length);
        exec('insertHorizontalRule');
        return;
      }
      for (const [re, run, okInLi] of actions) {
        const m = marker.match(re);
        if (!m) continue;
        if (inLi && !okInLi) return;
        run(m);
        stripMarker(atStart);
        return;
      }
      return;
    }

    // Inline — закрывающий символ разметки.
    const patterns = [
      [/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, 'strong'],
      [/__([^_\s](?:[^_]*[^_\s])?)__$/, 'strong'],
      [/~~([^~\s](?:[^~]*[^~\s])?)~~$/, 'del'],
      [/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, 'em'],
      [/(?:^|[^\p{L}\p{N}_])_([^_\s](?:[^_]*[^_\s])?)_$/u, 'em'],
      [/`([^`]+)`$/, 'code'],
    ];
    for (const [re, tag] of patterns) {
      const m = before.match(re);
      if (!m) continue;
      const full = m[0].slice(m[0].indexOf(tag === 'code' ? '`' : m[0].match(/[*_~]/)[0]));
      const r = document.createRange();
      r.setStart(node, range.startOffset - full.length);
      r.setEnd(node, range.startOffset);
      const el = document.createElement(tag);
      el.textContent = m[1];
      placeInline(r, el);
      return;
    }
  }

  function deleteBefore(node, offset, length) {
    const r = document.createRange();
    r.setStart(node, Math.max(0, offset - length));
    r.setEnd(node, offset);
    r.deleteContents();
  }

  // Убирает маркер в начале блока после его смены. Курсор браузер после formatBlock/insertList ставит
  // по-разному (то в начало, то в конец), поэтому маркер ищем по тексту, а не перед курсором.
  // Пустой строке нужен <br>, иначе в ней не встанет курсор.
  function stripMarker(marker) {
    const r = selRange();
    const block = r && closestIn(r.startContainer, 'li, h1, h2, h3, blockquote, pre, p');
    if (!block) return;
    const norm = (t) => t.replace(/\u00A0/g, ' ');
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.nodeValue.replace(/\u200B/g, '')) node = walker.nextNode();
    if (!node) return;
    const lead = node.nodeValue.match(/^\u200B*/)[0].length;
    if (!norm(node.nodeValue.slice(lead)).startsWith(norm(marker).trimStart())) return;
    node.deleteData(0, lead + marker.trimStart().length);
    const caret = document.createRange();
    if (!block.textContent.replace(/\u200B/g, '') && !block.querySelector('br, ul, ol')) {
      const br = document.createElement('br');
      node.after(br);
      caret.setStartBefore(br);
    } else caret.setStart(node, 0);
    caret.collapse(true);
    const sel = getSel();
    sel.removeAllRanges();
    sel.addRange(caret);
  }

  // Текст блока от его начала до курсора (только если курсор в том же текстовом узле, что и начало).
  function blockTextBefore(block, node, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let first = walker.nextNode();
    while (first && !first.nodeValue.replace(/\u200B/g, '')) first = walker.nextNode();
    return first === node ? node.nodeValue.slice(0, offset) : null;
  }

  visual.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data || [...(data.files || [])].some((f) => f.type.startsWith('image/'))) return; // картинки — в «Визуальные пояснения»
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    if (closestIn(selRange()?.startContainer, 'pre, code')) {
      exec('insertText', text);
      return;
    }
    let clean = html ? sanitizeHtml(html, document) : renderMarkdown(text);
    // Один абзац вставляем внутрь текущей строки, а не отдельным блоком.
    const single = clean.match(/^<p>([\s\S]*)<\/p>$/);
    if (single && !single[1].includes('</p>')) clean = single[1];
    if (clean) exec('insertHTML', clean);
    syncFromVisual();
  });

  return {
    focus: () => (root.dataset.mode === 'source' ? source : visual).focus(),
    getValue: () => last,
    // Нажатие, перехваченное снаружи до редактора; обрабатывается, только если фокус в визуальном поле.
    handleKeydown: (e) => e.composedPath().includes(visual) && onKeydown(e),
  };
}

// Текст блока кода: <br> и вложенные блоки — переносы строк.
function preText(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeName === 'BR') out += '\n';
    else if (n.nodeType === 1) out += (/^(DIV|P)$/.test(n.nodeName) && out && !out.endsWith('\n') ? '\n' : '') + preText(n);
  }
  return out;
}

// Выделение в том дереве, где лежит узел: в Shadow DOM document.getSelection() показывает вместо узлов
// теневого дерева его хост, а ShadowRoot.getSelection() (Chrome) — настоящие узлы.
function selectionOf(node) {
  const root = node.getRootNode();
  return typeof root.getSelection === 'function' ? root.getSelection() : document.getSelection();
}

function placeCaretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = selectionOf(el);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---------- Режим Markdown: кнопки вставляют разметку вокруг выделения ----------

function sourceCommand(ta, cmd) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e);
  const wrapWith = (mark, fallback) => {
    const text = sel || fallback;
    replace(s, e, `${mark}${text}${mark}`, s + mark.length, s + mark.length + text.length);
  };
  const replace = (from, to, text, selFrom, selTo) => {
    ta.focus();
    ta.setSelectionRange(from, to);
    if (!document.execCommand?.('insertText', false, text)) ta.setRangeText(text, from, to, 'end'); // execCommand — с поддержкой отмены
    ta.setSelectionRange(selFrom, selTo);
  };
  // Префикс для каждой строки выделения (или текущей строки).
  const prefixLines = (make) => {
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const endIdx = value.indexOf('\n', e);
    const end = endIdx < 0 ? value.length : endIdx;
    const lines = value.slice(start, end).split('\n');
    const text = lines.map((l, k) => make(k) + l).join('\n');
    replace(start, end, text, start + text.length, start + text.length);
  };
  switch (cmd) {
    case 'bold':
      return wrapWith('**', 'жирный');
    case 'italic':
      return wrapWith('_', 'курсив');
    case 'strike':
      return wrapWith('~~', 'текст');
    case 'code':
      return sel.includes('\n') ? replace(s, e, `\`\`\`\n${sel}\n\`\`\``, s + 4, s + 4 + sel.length) : wrapWith('`', 'код');
    case 'link': {
      const text = sel || 'текст';
      const out = `[${text}](https://)`;
      return replace(s, e, out, s + text.length + 3, s + out.length - 1);
    }
    case 'heading':
      return prefixLines(() => '### ');
    case 'ul':
      return prefixLines(() => '- ');
    case 'ol':
      return prefixLines((k) => `${k + 1}. `);
    case 'task':
      return prefixLines(() => '- [ ] ');
    case 'quote':
      return prefixLines(() => '> ');
    case 'hr':
      return replace(s, e, `${s && value[s - 1] !== '\n' ? '\n' : ''}\n---\n`, s + 6, s + 6);
  }
}
