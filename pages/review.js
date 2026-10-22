import * as store from '../lib/store.js';
import { escapeHtml, formatDate, LIGHTBOX_CSS, MD_CSS, installLightbox, installToc, lightboxIcons } from '../lib/report.js';
import { groupsOf, pagesCount, pageKey } from '../lib/groups.js';
import * as folder from '../lib/folder.js';
import { normalizeUrl, safeHref } from '../lib/url.js';
import { icon } from '../lib/icons.js';
import { editorHtml, mountEditor } from './md-editor.js';
import { codeFingerprint, REOPEN_KEY } from '../lib/code-version.js';

const main = document.getElementById('main');
document.head.append(Object.assign(document.createElement('style'), { textContent: LIGHTBOX_CSS + MD_CSS }));
// Скриншоты открываются тем же просмотрщиком, что в HTML-отчёте, и листаются в пределах группы.
installLightbox(document, lightboxIcons(), { selector: '.variant .shot img' });
document.getElementById('btn-new').innerHTML = `${icon('plus', 14)} Новое ревью`;
const list = document.getElementById('review-list');
const savedEl = Object.assign(document.createElement('div'), { className: 'saved', textContent: 'Сохранено' });
document.body.append(savedEl);

let currentId = new URLSearchParams(location.search).get('id');
let lastLocalWrite = 0;
let savedTimer = 0;
let disposeToc = null; // снимает подсветку навигации «В этом ревью» прошлой отрисовки

function flashSaved() {
  savedEl.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1000);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Страховка автосохранения: в папку пишет фоновый скрипт (через секунду после изменения), но браузер может
// остановить его посреди записи. Через пару секунд дописываем отсюда то, что так и не попало на диск;
// уже сохранённое не трогается, а записи с фоновым скриптом идут по очереди (lib/folder.js).
const flushSoon = debounce(() => folder.flushUnsaved(), 2500);

async function write(fn) {
  lastLocalWrite = Date.now();
  await fn();
  lastLocalWrite = Date.now();
  flashSaved();
  flushSoon();
}

function setUrl(id) {
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  url.hash = '';
  history.replaceState(null, '', url);
}

// ---------- Список ревью: поиск, сортировка, удаление ----------

const searchEl = document.getElementById('search');
const sortEl = document.getElementById('sort');
const foundEl = document.getElementById('found');
document.getElementById('search-icon').innerHTML = icon('magnifier', 14);

const SORTS = {
  'updated-desc': (a, b) => b.updatedAt - a.updatedAt,
  'created-desc': (a, b) => b.createdAt - a.createdAt,
  'created-asc': (a, b) => a.createdAt - b.createdAt,
  'title-asc': (a, b) => a.title.localeCompare(b.title, 'ru', { numeric: true }),
  'issues-desc': (a, b) => b.issueCount - a.issueCount || b.updatedAt - a.updatedAt,
};

function matches(meta, query) {
  if (!query) return true;
  const hay = meta.search ?? `${meta.title}\n${meta.author}`.toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word)); // все слова запроса, в любом порядке
}

async function renderList(activeId) {
  const all = await store.listReviews();
  const query = searchEl.value.trim().toLowerCase();
  const reviews = all.filter((r) => matches(r, query)).sort(SORTS[sortEl.value] || SORTS['updated-desc']);
  foundEl.textContent = query ? `Найдено: ${reviews.length} из ${all.length}` : all.length > 1 ? `Всего: ${all.length}` : '';
  list.innerHTML = reviews.length
    ? reviews
        .map(
          (r) => `<li data-id="${r.id}" class="${r.id === currentId ? 'current' : ''}">
        <div class="li-main">
          <div class="t"></div>
          <small>${countsText(r)} · ${formatDate(r.updatedAt)}</small>${r.id === activeId ? '<span class="badge">текущее</span>' : ''}
        </div>
        <button class="li-del" data-act="delete" title="Удалить ревью">${icon('trash', 14)}</button>
      </li>`,
        )
        .join('')
    : `<li class="empty-list">${all.length ? 'Ничего не найдено' : 'Ревью пока нет'}</li>`;
  list.querySelectorAll('li[data-id]').forEach((li, k) => {
    const meta = reviews[k];
    li.querySelector('.t').textContent = meta.title;
    li.addEventListener('click', () => {
      currentId = meta.id;
      setUrl(currentId);
      render();
    });
    li.querySelector('[data-act=delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await deleteReviewFlow(meta) && currentId === meta.id) currentId = null;
      render();
    });
  });
  list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
  updateSideShades();
  return all;
}

function countsText({ groupCount = 0, issueCount = 0 }) {
  return `${groupCount} ${plural(groupCount, 'группа', 'группы', 'групп')} · ${issueCount} ${plural(issueCount, 'вариант', 'варианта', 'вариантов')}`;
}

// Тени у краёв списка: подсказывают, что ревью больше, чем помещается.
const listWrap = document.getElementById('list-wrap');
function updateSideShades() {
  listWrap.classList.toggle('shade-top', list.scrollTop > 2);
  listWrap.classList.toggle('shade-bottom', list.scrollTop + list.clientHeight < list.scrollHeight - 2);
}
list.addEventListener('scroll', updateSideShades, { passive: true });
window.addEventListener('resize', updateSideShades);

// ---------- Окна подтверждения (вместо системных confirm/alert/prompt с заголовком «Confirm action on <id>») ----------

// Возвращает Promise<{ ok, value, action }>. ok=true — нажата основная кнопка; action — 'ok' | 'cancel' | 'extra' | ''.
function showDialog({
  label = 'Предупреждение',
  labelIcon = 'warning',
  question,
  alertTitle = '',
  alertItems = [], // строки (текст) или { text, code }
  note = '',
  input = null, // { value, placeholder }
  confirmText = 'OK',
  confirmIcon = '',
  confirmClass = 'btn-delete',
  cancelText = 'Отмена', // null — без кнопки отмены (информационное окно)
  extra = null, // { text, icon, onClick } или { text, icon, close: true } — закрыть окно с action 'extra'
}) {
  const dlg = document.getElementById('danger');
  dlg.classList.toggle('info', labelIcon !== 'warning');
  dlg.innerHTML = `
    <form method="dialog">
      <div class="danger-head">${icon(labelIcon, 18)}<span class="danger-label"></span></div>
      <h2 class="danger-q"></h2>
      ${alertTitle || alertItems.length ? `<div class="danger-alert">${alertTitle ? '<b></b>' : ''}<ul></ul></div>` : ''}
      ${note ? '<p class="danger-note"></p>' : ''}
      ${input ? '<input class="danger-input" type="text" maxlength="200">' : ''}
      <div class="danger-actions">
        ${extra ? `<button type="button" class="btn btn-light" data-act="extra">${extra.icon ? icon(extra.icon, 14) : ''} <span></span></button>` : ''}
        <span class="spacer"></span>
        ${cancelText ? `<button value="cancel" class="btn btn-light" ${input ? '' : 'autofocus'}></button>` : ''}
        <button value="ok" class="btn ${confirmClass}" ${cancelText || input ? '' : 'autofocus'}>${confirmIcon ? icon(confirmIcon, 14) : ''} <span></span></button>
      </div>
    </form>`;
  // Пользовательский текст — только через textContent.
  dlg.querySelector('.danger-label').textContent = label;
  dlg.querySelector('.danger-q').textContent = question;
  if (alertTitle) dlg.querySelector('.danger-alert b').textContent = alertTitle;
  const ul = dlg.querySelector('.danger-alert ul');
  for (const item of alertItems) {
    const li = document.createElement('li');
    if (typeof item === 'string') li.textContent = item;
    else {
      const code = document.createElement('code');
      code.textContent = item.code;
      li.append(item.before || '', code, item.after || '');
    }
    ul.append(li);
  }
  if (ul && !ul.children.length) ul.remove();
  if (note) dlg.querySelector('.danger-note').textContent = note;
  if (cancelText) dlg.querySelector('button[value=cancel]').textContent = cancelText;
  dlg.querySelector('button[value=ok] span').textContent = confirmText;
  if (extra) {
    dlg.querySelector('[data-act=extra] span').textContent = extra.text;
    dlg.querySelector('[data-act=extra]').addEventListener('click', extra.close ? () => dlg.close('extra') : extra.onClick);
  }
  const field = dlg.querySelector('.danger-input');
  if (field) {
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
    // Enter в поле — основная кнопка (по умолчанию форма отправилась бы первой кнопкой, «Отмена»)
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dlg.close('ok');
      }
    });
  }
  dlg.returnValue = '';
  dlg.showModal();
  if (field) {
    field.focus();
    field.select();
  }
  return new Promise((resolve) =>
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', value: field?.value ?? '', action: dlg.returnValue }), { once: true }),
  );
}

const notify = (question, note = '') => showDialog({ question, note, confirmText: 'Понятно', confirmClass: 'btn-primary', cancelText: null });

// Удаление ревью вместе с его папкой в uniform-reviews-results. Возвращает true, если удалили.
async function confirmReviewDeletion({ id, title, count, diskPath }) {
  const { ok } = await showDialog({
    question: `Удалить ревью «${title}»?`,
    alertTitle: 'Будут удалены без возможности восстановления:',
    alertItems: [
      count ? `${count} ${plural(count, 'вариант', 'варианта', 'вариантов')} блоков со скриншотами и стилями, все группы` : 'ревью и все его данные',
      ...(diskPath ? [{ before: 'папка ', code: diskPath, after: ' на диске — Отчёт.html, review.json и скриншоты' }] : []),
    ],
    note: 'Данные не сохранятся. Если отчёт ещё нужен — сначала скачайте его.',
    confirmText: 'Удалить навсегда',
    confirmIcon: 'trash',
    extra: { text: 'Скачать отчёт', icon: 'download', onClick: () => openReport(id, 'html') },
  });
  return ok;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function deleteReviewFlow({ id, title, createdAt, issueCount, issues }) {
  const dir = await folder.getDir();
  const sub = dir ? await folder.reviewFolderName({ id, title, createdAt }) : null;
  const count = issueCount ?? issues?.length ?? 0;
  if (!(await confirmReviewDeletion({ id, title, count, diskPath: sub ? `${dir.name}/${sub}` : '' }))) return false;
  // Сначала удаляем ревью — тогда отложенное автосохранение уже не пересоздаст его папку.
  await store.deleteReview(id);
  let result = { deleted: false };
  try {
    result = await folder.deleteReviewFolder({ id, title, createdAt }, { request: true });
  } catch (e) {
    result = { deleted: false, name: sub, reason: e.message };
  }
  if (sub && !result.deleted) {
    const why = result.reason === 'no-permission' ? 'нет разрешения на запись в папку' : result.reason;
    await notify('Ревью удалено, но папка на диске осталась', `Папку «${sub}» удалить не удалось (${why}). Удалите её вручную в ${dir.name}.`);
  }
  return true;
}

let searchTimer = 0;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => renderList(await store.getActiveReviewId()), 120);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl.value) {
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
  }
});
sortEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ reviewSort: sortEl.value });
  renderList(await store.getActiveReviewId());
});

async function render() {
  const activeId = await store.getActiveReviewId();
  if (!currentId) currentId = activeId;
  const reviews = await renderList(activeId);
  if (!currentId && reviews.length) {
    currentId = reviews[0].id;
    return render();
  }
  const review = await store.getReview(currentId);
  disposeToc?.();
  disposeToc = null;
  if (!review) {
    main.innerHTML = `<div class="empty"><b>Ревью не выбрано</b>Создайте новое ревью или выберите его слева.</div>`;
    return;
  }

  // Сохраняем фокус и позицию курсора, чтобы перерисовка не мешала вводу.
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.field ? [focused.closest('[data-scope]')?.dataset.scope, focused.dataset.field, focused.selectionStart, focused.selectionEnd] : null;

  const issues = review.issues;
  const entries = groupsOf(review);

  main.innerHTML = `
    <div class="rv-layout">
    <div class="rv-content">
    <div class="top" id="review-head">
      <div class="fields">
        <input class="title-input" data-field="review-title" maxlength="200">
        <input class="author-input" data-field="review-author" maxlength="100" placeholder="Ревьюер">
        <div class="tickets">
          <label>Тикет разработки <input type="text" data-field="review-devTicketUrl" maxlength="500" placeholder="Ссылка"></label>
          <a data-open="devTicketUrl" target="_blank" rel="noopener" title="Открыть">${icon('external', 14)}</a>
          <label>Тикет дизайна <input type="text" data-field="review-designTicketUrl" maxlength="500" placeholder="Ссылка"></label>
          <a data-open="designTicketUrl" target="_blank" rel="noopener" title="Открыть">${icon('external', 14)}</a>
        </div>
        <div class="meta">Создано ${formatDate(review.createdAt)} · ${countsText({ groupCount: (review.groups || []).length, issueCount: issues.length })}</div>
      </div>
      <div class="actions">
        <button class="btn btn-light" data-act="html" ${issues.length ? '' : 'disabled'}>${icon('download', 14)} Экспорт HTML</button>
        <button class="btn btn-primary" data-act="pdf" ${issues.length ? '' : 'disabled'}>${icon('download', 14)} Экспорт PDF</button>
      </div>
    </div>
    <div class="summary" id="groups">
      <button class="btn btn-light" data-act="add-group">${icon('plus', 14)} Новая группа</button>
      <span style="flex:1"></span>
      ${
        review.id === activeId
          ? '<span class="active-note">Новые блоки попадают в это ревью</span>'
          : '<button class="btn btn-light" data-act="activate">Сделать текущим</button>'
      }
      <button class="btn btn-danger" data-act="delete-review">${icon('trash', 14)} Удалить ревью</button>
    </div>
    ${
      entries.length
        ? entries.map((e, k) => groupHtml(e, k, entries, review)).join('')
        : `<div class="empty"><b>Блоков пока нет</b>Откройте сайт, нажмите на иконку расширения → «Выбрать элемент», выделите блок и сохраните его в группу. Тот же блок на других страницах добавляйте в эту же группу — здесь будет видно, чем варианты отличаются.</div>`
    }
    </div>
    ${navHtml(entries)}
    </div>`;

  const titleInput = main.querySelector('[data-field=review-title]');
  const authorInput = main.querySelector('[data-field=review-author]');
  const ticketInputs = ['devTicketUrl', 'designTicketUrl'].map((name) => [name, main.querySelector(`[data-field=review-${name}]`)]);
  titleInput.value = review.title;
  authorInput.value = review.author || '';
  const syncTicketLink = (name, url) => {
    const a = main.querySelector(`[data-open=${name}]`);
    a.hidden = !safeHref(url);
    a.href = safeHref(url) || '#';
  };
  for (const [name, input] of ticketInputs) {
    input.value = review[name] || '';
    syncTicketLink(name, review[name]);
  }
  const saveReviewMeta = debounce(() => {
    const patch = { title: titleInput.value.trim() || 'Дизайн-ревью', author: authorInput.value.trim() };
    for (const [name, input] of ticketInputs) {
      const link = normalizeUrl(input.value);
      input.classList.toggle('invalid', !link.ok);
      if (!link.ok) continue; // некорректную ссылку не сохраняем, пока её не исправят
      patch[name] = link.url;
      syncTicketLink(name, link.url);
    }
    write(() => store.updateReview(review.id, patch));
  }, 400);
  for (const input of [titleInput, authorInput, ...ticketInputs.map(([, i]) => i)]) input.addEventListener('input', saveReviewMeta);

  main.querySelector('[data-act=html]').addEventListener('click', () => openReport(review.id, 'html'));
  main.querySelector('[data-act=pdf]').addEventListener('click', () => openReport(review.id, 'pdf'));
  main.querySelector('[data-act=activate]')?.addEventListener('click', async () => {
    await store.setActiveReviewId(review.id);
    render();
  });
  main.querySelector('[data-act=delete-review]').addEventListener('click', async () => {
    if (!(await deleteReviewFlow(review))) return;
    currentId = null;
    render();
  });
  main.querySelector('[data-act=add-group]').addEventListener('click', async () => {
    const title = await askGroupTitle();
    if (!title) return;
    let group;
    await write(async () => (group = await store.addGroup(review.id, title)));
    await render();
    document.getElementById(`group-${group.id}`)?.scrollIntoView({ block: 'start' });
  });

  for (const card of main.querySelectorAll('[data-group]')) {
    const entry = entries.find((e) => e.group.id === card.dataset.group);
    bindGroup(card, review, entry);
  }
  for (const card of main.querySelectorAll('[data-issue]')) bindVariant(card, review, issues.find((i) => i.id === card.dataset.issue));
  disposeToc = installToc(document);

  if (focusKey) {
    const [scope, field, s, e] = focusKey;
    const el = scope ? main.querySelector(`[data-scope="${scope}"] [data-field="${field}"]`) : main.querySelector(`[data-field="${field}"]`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(s, e);
      } catch {}
    }
  }

  if (location.hash && !render.scrolled) {
    render.scrolled = true;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }
}

const plural4 = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

// Якорь карточки группы; у варианта без группы своего id нет.
const groupAnchor = (group) => (group.id ? `group-${group.id}` : 'group-ungrouped');

// Боковая навигация «В этом ревью» — как «В этом отчёте» в отчёте (lib/report.js); текущий раздел подсвечивает installToc.
function navHtml(entries) {
  if (!entries.length) return '';
  return `<nav class="r-nav" aria-label="Навигация по ревью"><div class="r-nav-inner">
      <div class="r-nav-title">В этом ревью:</div>
      <ul>
        <li><a href="#review-head">Ревью</a></li>
        <li><a href="#groups">Группы блоков</a>
          <ul>${entries
            .map(
              ({ group }, k) =>
                `<li><a href="#${escapeHtml(groupAnchor(group))}" data-nav-group="${escapeHtml(group.id)}"><span class="r-nav-num">#${k + 1}</span> <span class="r-nav-text">${escapeHtml(group.title)}</span></a></li>`,
            )
            .join('')}</ul>
        </li>
      </ul>
    </div></nav>`;
}

function groupHtml({ group, variants }, k, entries, review) {
  const orphan = !group.id;
  const pages = pagesCount(variants);
  return `
  <section class="group" id="${escapeHtml(groupAnchor(group))}" data-group="${escapeHtml(group.id)}" data-scope="g:${escapeHtml(group.id)}">
    <div class="group-head">
      <span class="num group-num">#${k + 1}</span>
      ${orphan ? `<h2 class="group-title"></h2>` : '<input type="text" data-field="title" maxlength="200" placeholder="Название группы">'}
      <span class="group-stats">${plural4(variants.length, 'вариант', 'варианта', 'вариантов')} · ${plural4(pages, 'страница', 'страницы', 'страниц')}</span>
      ${
        orphan
          ? ''
          : `<button class="icon-btn" data-act="up" title="Выше" ${k === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button class="icon-btn" data-act="down" title="Ниже" ${k >= entries.filter((e) => e.group.id).length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button class="icon-btn danger" data-act="delete" title="Удалить группу">${icon('trash')}</button>`
      }
    </div>
    ${
      orphan
        ? '<p class="group-hint">Эти варианты потеряли свою группу. Перенесите их в нужную группу.</p>'
        : `<div class="group-fields">
      <div class="field">
        <div class="field-label">Описание</div>
        ${editorHtml({ placeholder: 'Что это за блок и как он должен выглядеть везде. Поддерживается Markdown' })}
      </div>
      <div class="field">
        <div class="field-label">Ссылка на макет</div>
        <input type="url" data-field="mockupUrl" placeholder="Эталон в макете">
      </div>
    </div>`
    }
    ${
      variants.length
        ? `<div class="variants" data-lb-group>${variants.map((v, j) => variantHtml(v, j + 1, group, review)).join('')}</div>`
        : '<div class="group-empty">В группе пока нет вариантов. Снимите этот блок на сайте и выберите группу в форме.</div>'
    }
  </section>`;
}

function variantHtml(v, n, group, review) {
  const page = safeHref(v.page?.url);
  const others = (review.groups || []).filter((g) => g.id !== group.id);
  return `
    <article class="variant" id="${escapeHtml(v.id)}" data-issue="${escapeHtml(v.id)}" data-scope="v:${escapeHtml(v.id)}">
      <div class="variant-head">
        <span class="num">Вариант ${n}</span>
        <span class="spacer"></span>
        <select data-act="move" title="Перенести в другую группу">
          <option value="" selected>Перенести…</option>
          ${others.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join('')}
          <option value="__new">Новая группа…</option>
        </select>
        <button class="icon-btn danger" data-act="delete" title="Удалить вариант">${icon('trash')}</button>
      </div>
      ${
        v.screenshot
          ? `<div class="shot"><img src="${escapeHtml(v.screenshot)}" alt="" data-caption="${escapeHtml(`${group.title} · вариант ${n}`)}" title="Открыть на весь экран"></div>`
          : '<div class="shot-note">Скриншота нет</div>'
      }
      ${v.screenshotTruncated ? '<div class="shot-note">Блок снят не целиком — он слишком большой</div>' : ''}
      ${v.screenshotNote ? `<div class="shot-note">${escapeHtml(v.screenshotNote)}</div>` : ''}
      <div class="page">${
        page
          ? `<a href="${escapeHtml(page)}" target="_blank" rel="noopener">${escapeHtml(v.page?.title || pageKey(page))}</a><small>${escapeHtml(pageKey(page))}</small>`
          : '<span class="muted">Страница не указана</span>'
      }</div>
      <input type="text" data-field="note" maxlength="300" placeholder="Заметка: чем отличается этот вариант">
    </article>`;
}

// Название новой группы: null — отмена.
async function askGroupTitle(value = '') {
  const { ok, value: title } = await showDialog({
    label: 'Новая группа',
    labelIcon: 'plus',
    question: 'Как назвать группу?',
    note: 'Группа — один и тот же по логике блок: например, «Кнопка удаления» или «Модалка подтверждения».',
    input: { value, placeholder: 'Например: Кнопка удаления' },
    confirmText: 'Создать',
    confirmClass: 'btn-primary',
  });
  return ok && title.trim() ? title.trim() : null;
}

function bindGroup(card, review, { group, variants }) {
  if (!group.id) {
    card.querySelector('.group-title').textContent = group.title;
    return;
  }
  const f = (name) => card.querySelector(`.group-head [data-field=${name}], .group-fields [data-field=${name}]`);
  f('title').value = group.title;
  f('mockupUrl').value = group.mockupUrl || '';
  const save = debounce(() => {
    const link = normalizeUrl(f('mockupUrl').value);
    f('mockupUrl').classList.toggle('invalid', !link.ok);
    const patch = { title: f('title').value.trim() || 'Без названия', description: editor.getValue().trim() };
    if (link.ok) patch.mockupUrl = link.url;
    write(() => store.updateGroup(review.id, group.id, patch));
  }, 400);
  for (const name of ['title', 'mockupUrl']) f(name).addEventListener('input', save);
  // Своя правка страницу не перерисовывает — название в навигации меняем сразу
  const navText = main.querySelector(`.r-nav [data-nav-group="${group.id}"] .r-nav-text`);
  f('title').addEventListener('input', () => (navText.textContent = f('title').value.trim() || 'Без названия'));
  const editor = mountEditor(card.querySelector('[data-md]'), { value: group.description || '', onChange: save, askLink });

  card.querySelector('.group-head [data-act=up]').addEventListener('click', async () => {
    await write(() => store.moveGroup(review.id, group.id, -1));
    render();
  });
  card.querySelector('.group-head [data-act=down]').addEventListener('click', async () => {
    await write(() => store.moveGroup(review.id, group.id, 1));
    render();
  });
  card.querySelector('.group-head [data-act=delete]').addEventListener('click', async () => {
    const sub = variants.length && (await folder.getDir()) ? await folder.reviewFolderName(review) : null;
    const { ok } = await showDialog({
      question: `Удалить группу «${group.title}»?`,
      alertTitle: 'Будет удалено без возможности восстановления:',
      alertItems: [
        variants.length ? `${plural4(variants.length, 'вариант', 'варианта', 'вариантов')} со скриншотами и стилями` : 'пустая группа с описанием',
        ...(sub ? [{ before: 'их скриншоты и записи в ', code: sub, after: ' на диске' }] : []),
      ],
      note: variants.length ? 'Нужные варианты можно сначала перенести в другую группу.' : '',
      confirmText: 'Удалить',
      confirmIcon: 'trash',
    });
    if (!ok) return;
    await write(() => store.deleteGroup(review.id, group.id));
    render();
  });
}

function bindVariant(card, review, issue) {
  const note = card.querySelector('[data-field=note]');
  note.value = issue.note || '';
  note.addEventListener('input', debounce(() => write(() => store.updateIssue(review.id, issue.id, { note: note.value.trim() })), 400));

  const move = card.querySelector('[data-act=move]');
  move.addEventListener('change', async () => {
    const target = move.value;
    move.value = '';
    if (!target) return;
    const dest = target === '__new' ? { newGroupTitle: await askGroupTitle() } : { groupId: target };
    if (target === '__new' && !dest.newGroupTitle) return;
    await write(() => store.moveIssueToGroup(review.id, issue.id, dest));
    render();
  });

  card.querySelector('[data-act=delete]').addEventListener('click', async () => {
    const sub = (await folder.getDir()) ? await folder.reviewFolderName(review) : null;
    const { ok } = await showDialog({
      question: 'Удалить вариант?',
      alertTitle: 'Будет удалено без возможности восстановления:',
      alertItems: [
        `скриншот блока со страницы ${pageKey(issue.page?.url) || '—'} и его стили`,
        ...(sub ? [{ before: 'скриншот в ', code: sub, after: ' на диске' }] : []),
      ],
      note: 'Остальные варианты группы будут перенумерованы.',
      confirmText: 'Удалить',
      confirmIcon: 'trash',
    });
    if (!ok) return;
    await write(() => store.deleteIssue(review.id, issue.id));
    render();
  });
}

// Адрес ссылки для редактора описания. null — отмена, '' — убрать ссылку.
async function askLink(current) {
  const { ok, value } = await showDialog({
    label: 'Ссылка',
    labelIcon: 'link',
    question: current ? 'Изменить ссылку' : 'Добавить ссылку',
    note: 'Оставьте поле пустым, чтобы убрать ссылку.',
    input: { value: current, placeholder: 'https://…' },
    confirmText: 'Готово',
    confirmClass: 'btn-primary',
  });
  if (!ok) return null;
  if (!value.trim()) return '';
  const link = normalizeUrl(value);
  if (link.ok && link.url) return link.url;
  await notify('Некорректная ссылка', 'Нужен адрес вида https://…');
  return null;
}

function openReport(id, action) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/report.html?id=${id}&action=${action}`) });
}


// ---------- Фоновый скрипт на старом коде ----------
// Автосохранение в папку делает фоновый скрипт. Если файлы расширения обновили, а само расширение не
// перезагрузили, он продолжает работать на старом коде и пишет на диск данные в старом формате.
async function checkBackgroundCode() {
  const mine = await codeFingerprint();
  if (!mine) return;
  const reply = await chrome.runtime.sendMessage({ type: 'udc:codeVersion' }).catch(() => null);
  if (!reply || reply.fingerprint === mine) return;
  // Старый фоновый скрипт этого сообщения не знает и отвечает ошибкой — это тоже старый код.
  if (reply.ok !== false && !reply.fingerprint) return;
  const bar = document.createElement('div');
  bar.className = 'stale-bg';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = `${icon('warning', 18)}
    <div class="stale-text"><b>Расширение обновилось, но не перезагружено</b>
      <span>Фоновая часть работает на старой версии, поэтому автосохранение может записывать в папку неполные данные. Перезагрузите расширение — страница откроется снова.</span></div>
    <button class="btn btn-primary" data-act="reload-ext">Перезагрузить расширение</button>`;
  bar.querySelector('[data-act=reload-ext]').addEventListener('click', async () => {
    // Всё, что записал старый код, после перезагрузки перезапишется заново.
    await chrome.storage.local.remove('folderSynced');
    await chrome.storage.local.set({ [REOPEN_KEY]: location.href });
    chrome.runtime.reload();
  });
  document.body.append(bar);
}
checkBackgroundCode();

// ---------- Папка для результатов ----------

const folderEl = document.getElementById('folder');
let restored = null; // итог восстановления ревью из выбранной папки — показываем в блоке папки
let regainResult = null; // ответ браузера на запрос доступа по клику, если доступ не дали

// restore=true — сначала подтянуть ревью, сохранённые в папке раньше (например, до переустановки расширения).
async function saveAllToFolder(dir, { restore = false } = {}) {
  folderEl.querySelector('.folder-state').textContent = restore ? 'Ищу сохранённые ревью…' : 'Сохраняю…';
  try {
    if (restore) restored = await folder.importFromFolder(dir);
    await folder.writeAll(dir, await store.getAllReviews());
  } catch (e) {
    await folder.setStatus({ state: 'error', error: e.message });
  }
}

function restoredHtml() {
  if (!restored) return '';
  if (!restored.found) {
    return '<div class="folder-state warn">В этой папке нет сохранённых ревью. Сохраняли в другом месте? Нажмите «Сменить» и укажите ту папку</div>';
  }
  const summary = folder.importSummary(restored);
  const warn = restored.failed.length || restored.missingShots;
  return summary ? `<div class="folder-state ${warn ? 'warn' : 'ok'}">${escapeHtml(summary)}</div>` : '';
}

// Только из обработчика клика: браузер открывает выбор папки в ответ на действие пользователя.
async function pickFolder() {
  let dir;
  try {
    ({ dir } = await folder.pickResultsFolder());
  } catch (e) {
    if (e.name !== 'AbortError') await notify('Не удалось выбрать папку', e.message);
    return;
  }
  await saveAllToFolder(dir, { restore: true });
  renderFolder();
}

// Сверка с папкой: ревью, которые сохранялись в неё раньше, но их файлов там больше нет (папку очистили,
// удалили или перенесли из неё ревью вручную). Без доступа к папке проверить нельзя — тогда молчим.
async function checkMissing() {
  const check = await folder.checkFolderContents().catch(() => null);
  // Уже открыто другое окно (например, клик, вернувший доступ, был по «Удалить») — спросим при следующем открытии.
  if (!check?.missing.length || document.getElementById('danger').open) return;
  const { missing, found, folderGone, dirName } = check;
  const n = missing.length;
  const { action } = await showDialog({
    label: 'Папка для результатов',
    question: folderGone ? `Папки «${dirName}» больше нет` : found ? `В папке «${dirName}» нет ${n} ревью` : `Папка «${dirName}» пуста`,
    alertTitle: `${n === 1 ? 'Это ревью сохранялось' : 'Эти ревью сохранялись'} в папку раньше, но ${folderGone ? 'папку удалили или переместили' : 'файлы удалили или переместили'}:`,
    alertItems: missing.map((m) => `${m.title} — ${countsText(m)}`),
    note: 'Удаление из расширения необратимо: группы, скриншоты и описания пропадут. Если ревью ещё нужны — сохраните их заново.',
    confirmText: 'Удалить из расширения',
    confirmIcon: 'trash',
    cancelText: 'Решить позже',
    extra: folderGone ? { text: 'Выбрать папку заново', icon: 'folderOpen', close: true } : { text: 'Сохранить заново', icon: 'save', close: true },
  });
  const ids = missing.map((m) => m.id);
  if (action === 'ok') {
    await folder.forgetMissing(ids);
    if (ids.includes(currentId)) currentId = null;
  } else if (action === 'extra') {
    if (folderGone) await pickFolder();
    else await folder.resaveMissing(ids);
  } else return;
  render();
  renderFolder();
}

async function renderFolder() {
  const dir = await folder.getDir();
  const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
  const perm = dir ? await folder.permission(dir).catch(() => 'prompt') : null;

  let state;
  let buttons;
  if (!dir) {
    state = '<div class="folder-state warn">Не подключена. Выберите uniform-reviews-results в папке расширения или папку, где уже лежат ваши ревью</div>';
    buttons = `<button class="btn btn-primary" data-act="pick">${icon('folder', 14)} Выбрать uniform-reviews-results</button>`;
  } else if (perm !== 'granted') {
    state = regainResult
      ? `<div class="folder-state err">Браузер не дал доступ по клику (${escapeHtml(regainResult.error || `ответ: ${regainResult.state}`)}). Нажмите «Разрешить доступ»</div>`
      : '<div class="folder-state warn">Нет доступа к папке. Кликните в любом месте страницы — доступ вернётся (или браузер спросит разрешение)</div>';
    buttons = `<button class="btn btn-primary" data-act="grant">Разрешить доступ</button><button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить</button><button class="btn btn-danger" data-act="disconnect">${icon('linkSlash', 14)} Отключить</button>`;
  } else {
    state =
      status.state === 'error'
        ? `<div class="folder-state err">Ошибка записи: ${escapeHtml(status.error)}</div>`
        : `<div class="folder-state ok">Сохраняется автоматически${status.lastSyncAt ? ` · ${formatDate(status.lastSyncAt)}` : ''}</div>
           <div class="folder-state">Не закрывайте эту страницу: пока она открыта, ревью сохраняются в папку. После закрытия браузер забирает разрешение на запись.</div>`;
    buttons = `<button class="btn btn-light" data-act="save">${icon('save', 14)} Сохранить сейчас</button><button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить</button><button class="btn btn-danger" data-act="disconnect">${icon('linkSlash', 14)} Отключить</button>`;
  }
  folderEl.innerHTML = `
    <div class="folder-title">Папка для результатов</div>
    ${dir ? `<div class="folder-name">${icon('folder')} ${escapeHtml(folder.folderLabel(dir, status))}/</div>` : ''}
    ${state}
    ${dir ? restoredHtml() : ''}
    <div class="row">${buttons}</div>`;
  folderEl.classList.toggle('attention', !dir || perm !== 'granted');
  updateSideShades();

  folderEl.querySelector('[data-act=pick]')?.addEventListener('click', pickFolder);
  folderEl.querySelector('[data-act=disconnect]')?.addEventListener('click', async () => {
    const name = folder.folderLabel(dir, status);
    const { ok } = await showDialog({
      question: `Отключить папку «${name}»?`,
      alertItems: ['новые изменения ревью больше не будут записываться на диск', 'выбирать элементы на сайтах можно будет только после повторного подключения'],
      note: 'Уже сохранённые файлы останутся на диске.',
      confirmText: 'Отключить',
      confirmIcon: 'linkSlash',
    });
    if (!ok) return;
    await folder.disconnectFolder();
    restored = null;
    renderFolder();
  });
  folderEl.querySelector('[data-act=grant]')?.addEventListener('click', async () => {
    if ((await folder.permission(dir, true)) === 'granted') await saveAllToFolder(dir, { restore: true });
    renderFolder();
  });
  folderEl.querySelector('[data-act=save]')?.addEventListener('click', async () => {
    await saveAllToFolder(dir);
    renderFolder();
  });
}

chrome.storage.onChanged.addListener((changes, area) => area === 'local' && folder.KEY_FOLDER_STATUS in changes && renderFolder());
// Дописываем изменения, сделанные без открытой страницы (например, блоки, снятые на сайте). Если доступа нет —
// просим его при первом клике на странице: с «Разрешать всегда» браузер отдаёт его молча.
// Затем сверяемся с папкой: вдруг её очистили вручную, а ревью в расширении остались.
folder.flushUnsaved().finally(async () => {
  renderFolder();
  checkMissing();
  const dir = await folder.getDir();
  if (dir && (await folder.permission(dir).catch(() => 'prompt')) === 'prompt') {
    folder.regainAccessOnClick(document, dir, { ignore: '#folder, #danger' }).then((result) => {
      regainResult = result.state === 'granted' ? null : result;
      renderFolder();
      if (result.state === 'granted') checkMissing();
    });
  }
});

document.getElementById('btn-new').addEventListener('click', async () => {
  const { ok, value: title } = await showDialog({
    label: 'Новое ревью',
    labelIcon: 'plus',
    question: 'Как назвать ревью?',
    input: { value: 'Дизайн-ревью', placeholder: 'Например: Ревью страницы оплаты' },
    confirmText: 'Создать',
    confirmClass: 'btn-primary',
  });
  if (!ok) return;
  const author = (await store.getReview(currentId))?.author || '';
  const review = await store.createReview({ title, author });
  currentId = review.id;
  setUrl(currentId);
  render();
});

// Новые варианты из контент-скрипта появляются сразу; собственные правки не перерисовываем.
store.onReviewsChanged(() => {
  if (Date.now() - lastLocalWrite > 1000) render();
  else store.getActiveReviewId().then(renderList);
});

(async () => {
  const { reviewSort } = await chrome.storage.local.get('reviewSort');
  if (reviewSort && SORTS[reviewSort]) sortEl.value = reviewSort;
  await store.migrateIfNeeded();
  await store.reindexIfNeeded();
  render();
})();

