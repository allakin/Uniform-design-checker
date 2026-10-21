import * as store from '../lib/store.js';
import { escapeHtml, formatDate } from '../lib/report.js';
import { groupsOf, pagesCount } from '../lib/groups.js';
import * as folder from '../lib/folder.js';
import { normalizeUrl, safeHref } from '../lib/url.js';
import { icon } from '../lib/icons.js';

const app = document.getElementById('app');
const errorEl = document.getElementById('error');
const btnAll = document.getElementById('btn-all');

let view = 'auto'; // auto | list | create
// Сверка с папкой при открытии: ревью, файлы которых пропали из папки (удалили или перенесли вручную).
let folderCheck = { missing: [] };

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

function countsText({ groupCount = 0, issueCount = 0 }) {
  return `${count(groupCount, 'группа', 'группы', 'групп')} · ${count(issueCount, 'вариант', 'варианта', 'вариантов')}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function openPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

async function shortcut() {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'start-pick')?.shortcut || '';
}

async function render() {
  const [active, reviews] = await Promise.all([store.activeOrLatestReview(), store.listReviews()]);
  btnAll.hidden = !reviews.length || view === 'list';

  if (view === 'list') return renderList(reviews, active);
  const ids = new Set(reviews.map((r) => r.id));
  const missing = folderCheck.missing.filter((m) => ids.has(m.id));
  if (view === 'auto' && missing.length) return renderMissing({ ...folderCheck, missing });
  if (view === 'create' || !active) return renderCreate(reviews);
  return renderActive(active);
}

async function renderCreate(reviews) {
  // Папка не подключена — например, расширение переустановили: ревью можно вернуть из сохранённых файлов.
  const canRestore = !(await folder.getDir());
  app.innerHTML = `
    <form id="create">
      <h2>Новое ревью</h2>
      <label>Название
        <input type="text" name="title" maxlength="200" placeholder="Например: Ревью страницы оплаты">
      </label>
      <label>Ревьюер
        <input type="text" name="author" maxlength="100" placeholder="Имя (необязательно)">
      </label>
      <label>Ссылка на тикет разработки
        <input type="text" name="devTicketUrl" maxlength="500" placeholder="Ссылка">
        <span class="field-err" hidden>Похоже, это не ссылка</span>
      </label>
      <label>Ссылка на тикет дизайна
        <input type="text" name="designTicketUrl" maxlength="500" placeholder="Ссылка">
        <span class="field-err" hidden>Похоже, это не ссылка</span>
      </label>
      <div class="row">
        <button type="submit" class="btn btn-primary">Создать ревью</button>
        ${reviews.length ? '<button type="button" class="btn btn-light" data-act="back">Отмена</button>' : ''}
      </div>
    </form>
    ${
      canRestore
        ? `<section class="restore">
            <b>Уже делали ревью раньше?</b>
            <span>Прошлые ревью хранятся на диске: по умолчанию в папке <code>uniform-reviews-results</code> внутри папки расширения или в той папке, которую вы выбрали сами. Чтобы восстановить их, укажите эту папку повторно — ревью вернутся в список вместе со скриншотами.</span>
            <button type="button" class="btn btn-light" data-act="restore">${icon('folderOpen', 14)} Восстановить ревью из папки</button>
          </section>`
        : ''
    }`;
  const form = app.querySelector('#create');
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    const host = hostOf(tab?.url);
    if (host) form.title.placeholder = `Например: Ревью ${host}`;
  });
  store.getActiveReview().then((r) => r?.author && (form.author.value = r.author));
  form.title.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const links = {};
    for (const name of ['devTicketUrl', 'designTicketUrl']) {
      const input = form[name];
      const link = normalizeUrl(input.value);
      input.classList.toggle('invalid', !link.ok);
      input.nextElementSibling.hidden = link.ok;
      if (!link.ok) return input.focus();
      links[name] = link.url;
    }
    await store.createReview({ title: form.title.value || form.title.placeholder.replace(/^Например: /, ''), author: form.author.value, ...links });
    // Первый запуск: сначала нужно подключить папку uniform-reviews-results.
    if (!(await folder.getDir())) return openPage('pages/setup.html');
    view = 'auto';
    render();
  });
  app.querySelector('[data-act=back]')?.addEventListener('click', () => {
    view = 'auto';
    render();
  });
  // Системный диалог выбора папки из popup не открыть (popup закрывается) — восстанавливаем на странице настройки.
  app.querySelector('[data-act=restore]')?.addEventListener('click', () => openPage('pages/setup.html?restore=1'));
}

// Папку очистили, удалили или перенесли из неё ревью, а в расширении они остались. Без этого экрана popup
// показывал бы ревью как сохранённые. Решает пользователь: убрать их из расширения или записать заново.
function renderMissing({ missing, found, folderGone, dirName }) {
  const n = missing.length;
  const title = folderGone
    ? `Папки «${dirName}» больше нет`
    : found
      ? `В папке «${dirName}» нет ${n} ревью`
      : `Папка «${dirName}» пуста`;
  app.innerHTML = `
    <section class="missing">
      <b class="missing-title">${icon('warning', 16)}<span></span></b>
      <span>${n === 1 ? 'Это ревью сохранялось' : 'Эти ревью сохранялись'} в папку раньше, но ${folderGone ? 'папку удалили или переместили' : 'файлы удалили или переместили'}. В расширении ${n === 1 ? 'оно осталось' : 'они остались'}:</span>
      <ul class="review-list">
        ${missing.map((r) => `<li><div class="t"><div></div><small>${countsText(r)} · ${formatDate(r.updatedAt)}</small></div></li>`).join('')}
      </ul>
      <button class="btn btn-danger btn-big" data-act="forget">${icon('trash', 16)} Удалить из расширения</button>
      ${
        folderGone
          ? `<button class="btn btn-light btn-big" data-act="other-folder">${icon('folderOpen', 16)} Выбрать папку заново</button>`
          : `<button class="btn btn-light btn-big" data-act="resave">${icon('save', 16)} Сохранить в папку заново</button>
             <button class="link" data-act="other-folder">Ревью лежат в другой папке? Укажите её</button>`
      }
      <span class="missing-note">Удаление необратимо: группы, скриншоты и описания пропадут. Если ревью ещё нужны — сохраните их заново.</span>
    </section>`;
  // Пользовательский текст вставляем через textContent.
  app.querySelector('.missing-title span').textContent = title;
  app.querySelectorAll('.missing li').forEach((li, k) => (li.querySelector('.t div').textContent = missing[k].title));
  const ids = missing.map((m) => m.id);
  app.querySelector('[data-act=forget]').addEventListener('click', async () => {
    await folder.forgetMissing(ids);
    folderCheck = { missing: [] };
    view = 'auto';
    render();
  });
  app.querySelector('[data-act=resave]')?.addEventListener('click', async () => {
    await folder.resaveMissing(ids);
    folderCheck = { missing: [] };
    render();
  });
  // Сменить папку можно только на странице расширения: из popup системный диалог выбора не открыть.
  app.querySelector('[data-act=other-folder]').addEventListener('click', () => openPage('pages/review.html#folder'));
}

function renderList(reviews, active) {
  app.innerHTML = `
    <div class="row"><h2 style="margin:0">Все ревью</h2><span class="spacer"></span>
      <button class="link" data-act="new">${icon('plus', 12)} Новое ревью</button></div>
    <ul class="review-list">
      ${reviews
        .map(
          (r) => `<li data-id="${r.id}" class="${r.id === active?.id ? 'active' : ''}">
            <div class="t"><div>${escapeHtml(r.title)}</div>
            <small>${countsText(r)} · ${formatDate(r.updatedAt)}</small></div>
            ${r.id === active?.id ? '<small>текущее</small>' : ''}
          </li>`,
        )
        .join('')}
    </ul>
    <button class="btn btn-light" data-act="back">Назад</button>`;
  app.querySelectorAll('.review-list li').forEach((li) =>
    li.addEventListener('click', async () => {
      await store.setActiveReviewId(li.dataset.id);
      view = 'auto';
      render();
    }),
  );
  app.querySelector('[data-act=new]').addEventListener('click', () => {
    view = 'create';
    render();
  });
  app.querySelector('[data-act=back]').addEventListener('click', () => {
    view = 'auto';
    render();
  });
}

async function renderActive(review) {
  const issues = review.issues;
  const groups = groupsOf(review);
  const { exportFormat = 'html' } = await chrome.storage.local.get('exportFormat');
  const keys = await shortcut();
  const hasFolder = !!(await folder.getDir());

  app.innerHTML = `
    <section class="review-card">
      <div class="card-head">
        <div class="title"></div>
        <div class="meta">${countsText({ groupCount: (review.groups || []).length, issueCount: issues.length })} · создано ${formatDate(review.createdAt)}${review.author ? ` · ${escapeHtml(review.author)}` : ''}</div>
      </div>
      ${ticketLinks(review)}
      <div class="row card-actions">
        <button class="link" data-act="open">${icon('pencil', 12)} Открыть и редактировать</button>
        <span class="spacer"></span>
        <button class="link" data-act="new">${icon('plus', 12)} Новое ревью</button>
      </div>
    </section>

    ${
      hasFolder
        ? `<section class="pick">
          <div class="pick-row">
            <button class="btn btn-primary btn-big" data-act="pick">${icon('target', 18)} Выбрать элемент ${keys ? `<kbd>${escapeHtml(keys)}</kbd>` : ''}</button>
            <button class="btn btn-light btn-timer" data-act="pick-delay" title="Через 3 секунды: успейте открыть выпадающий список, меню или наведение">${icon('stopwatch')} 3 с</button>
          </div>
          <div class="pick-hint">Кликните по блоку или протяните мышью область, затем выберите группу — один и тот же блок с разных страниц. Для открытых меню и попапов: «3 с» или ${keys ? escapeHtml(keys) : 'горячая клавиша'} при открытом меню.</div>
          ${
            keys
              ? `<button class="link shortcut-link" data-act="shortcut">${icon('keyboard', 14)} Изменить горячую клавишу (${escapeHtml(keys)})</button>`
              : `<div class="shortcut-warn">${icon('keyboard', 14)} Горячая клавиша не назначена — браузер мог отдать её другому расширению.
                  <button class="link" data-act="shortcut">Назначить</button></div>`
          }
          </section>`
        : `<section class="setup">
            <b>Перед первым ревью подключите папку результатов</b>
            <span>Отчёты, данные и скриншоты сохраняются в <code>uniform-reviews-results</code> в папке расширения. Браузер попросит один раз указать её. Ревью, сохранённые там раньше, подтянутся.</span>
            <button class="btn btn-primary btn-big" data-act="setup">${icon('folder', 18)} Подключить uniform-reviews-results</button>
          </section>`
    }

    <section>
      <h2>Группы блоков</h2>
      ${
        groups.length
          ? `<ul class="issues">${groups
              .map(({ group, variants }, k) => {
                const shot = variants.find((v) => v.screenshot)?.screenshot;
                return `<li data-id="${escapeHtml(group.id ? `group-${group.id}` : variants[0]?.id || '')}">
                  <span class="n">${k + 1}</span>
                  ${shot ? `<img src="${escapeHtml(shot)}" alt="">` : '<span class="no-shot"></span>'}
                  <span class="t"><div></div><small>${count(variants.length, 'вариант', 'варианта', 'вариантов')} · ${count(pagesCount(variants), 'страница', 'страницы', 'страниц')}</small></span>
                </li>`;
              })
              .join('')}</ul>`
          : '<div class="empty">Пока пусто. Нажмите «Выбрать элемент», выделите блок на странице и сохраните его в группу. Тот же блок на других страницах добавляйте в эту же группу.</div>'
      }
    </section>

    <section class="export">
      <h2>Экспорт всего ревью</h2>
      <div class="export-row">
        <div class="seg">
          <label><input type="radio" name="fmt" value="html" ${exportFormat === 'html' ? 'checked' : ''}>HTML</label>
          <label><input type="radio" name="fmt" value="pdf" ${exportFormat === 'pdf' ? 'checked' : ''}>PDF</label>
        </div>
        <button class="btn btn-outline" data-act="export" ${issues.length ? '' : 'disabled'}>Экспортировать</button>
      </div>
      <button class="folder-line" data-act="folder"></button>
      <div class="keep-open" hidden>Чтобы ревью сохранялись в папку, держите <button class="link" data-act="keep-open">страницу ревью</button> открытой — иначе браузер забирает разрешение на запись.</div>
    </section>`;
  renderFolderLine(app.querySelector('[data-act=folder]'), review.id);
  // Разрешение на запись в папку живёт, только пока открыта страница расширения — предупреждаем, если папка подключена.
  app.querySelector('.keep-open').hidden = !hasFolder;
  app.querySelector('[data-act=keep-open]').addEventListener('click', () => openPage(`pages/review.html?id=${review.id}`));

  // Пользовательский текст вставляем через textContent.
  app.querySelector('.review-card .title').textContent = review.title;
  app.querySelectorAll('.issues li').forEach((li, k) => (li.querySelector('.t div').textContent = groups[k].group.title));

  app.querySelector('[data-act=pick]')?.addEventListener('click', () => startPick(0));
  app.querySelector('[data-act=pick-delay]')?.addEventListener('click', () => startPick(3));
  app.querySelector('[data-act=shortcut]')?.addEventListener('click', openShortcuts);
  app.querySelector('[data-act=setup]')?.addEventListener('click', () => openPage('pages/setup.html'));
  app.querySelector('[data-act=open]').addEventListener('click', () => openPage(`pages/review.html?id=${review.id}`));
  app.querySelector('[data-act=tickets]')?.addEventListener('click', () => openPage(`pages/review.html?id=${review.id}`));
  app.querySelector('[data-act=new]').addEventListener('click', () => {
    view = 'create';
    render();
  });
  app.querySelectorAll('.issues li').forEach((li) =>
    li.addEventListener('click', () => openPage(`pages/review.html?id=${review.id}#${li.dataset.id}`)),
  );
  app.querySelectorAll('input[name=fmt]').forEach((r) =>
    r.addEventListener('change', () => chrome.storage.local.set({ exportFormat: r.value })),
  );
  app.querySelector('[data-act=export]').addEventListener('click', () => {
    const fmt = app.querySelector('input[name=fmt]:checked').value;
    openPage(`pages/report.html?id=${review.id}&action=${fmt}`);
  });
}

function ticketLinks(review) {
  const links = [
    ['Тикет разработки', safeHref(review.devTicketUrl)],
    ['Тикет дизайна', safeHref(review.designTicketUrl)],
  ].filter(([, href]) => href);
  if (!links.length) return `<div class="row tickets"><button class="link" data-act="tickets">${icon('link', 12)} Добавить ссылки на тикеты</button></div>`;
  return `<div class="row tickets">${links
    .map(([label, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(href)}">${label} ${icon('external', 12)}</a>`)
    .join('')}</div>`;
}

async function renderFolderLine(el, reviewId) {
  const dir = await folder.getDir();
  const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
  const perm = dir ? await folder.permission(dir).catch(() => 'prompt') : null;
  // Писать в папку браузер даёт, только пока открыта страница расширения (popup не в счёт): закрыли страницу ревью —
  // доступа нет, и новые замечания в папку не попадут, пока его не запросят снова.
  const unsaved = dir ? (await folder.unsavedReviews()).length : 0;
  if (!dir) {
    el.innerHTML = `${icon('folder', 14)}<span>Сохранять на диск: <u>подключить uniform-reviews-results</u></span>`;
  } else if (status.state === 'error' && perm === 'granted') {
    el.innerHTML = `${icon('warning', 14)}<span>Ошибка записи в «${escapeHtml(dir.name)}»: <u>подробнее</u></span>`;
    el.classList.add('warn');
  } else if (perm !== 'granted') {
    el.innerHTML = `${icon('folder', 14)}<span>Нужно разрешение на запись в «${escapeHtml(dir.name)}»${unsaved ? ` (не сохранено: ${unsaved} ревью)` : ''}: <u>запросить</u></span>`;
    el.classList.add('warn');
  } else if (unsaved) {
    el.innerHTML = `${icon('folder', 14)}<span>Не сохранено в «${escapeHtml(dir.name)}»: ${unsaved} ревью — <u>сохранить</u></span>`;
    el.classList.add('warn');
  } else {
    el.innerHTML = `${icon('folder', 14)}<span>Сохраняется в «${escapeHtml(folder.folderLabel(dir, status))}»${status.lastSyncAt ? ` · ${new Date(status.lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>`;
  }
  el.addEventListener('click', async () => {
    // Без доступа — страница ревью: там по клику браузер вернёт доступ (из popup запрос не появляется),
    // и её же нужно держать открытой, чтобы ревью продолжали сохраняться.
    if (dir && perm !== 'granted') return openPage(`pages/review.html?id=${reviewId}`);
    if (unsaved && (await folder.flushUnsaved())) return render();
    openPage('pages/review.html#folder');
  });
}

// Страница горячих клавиш расширений. В Яндекс Браузере она называется browser://, chrome:// тоже понимает.
async function openShortcuts() {
  for (const url of ['chrome://extensions/shortcuts', 'browser://extensions/shortcuts']) {
    try {
      await chrome.tabs.create({ url });
      window.close();
      return;
    } catch {}
  }
  showError('Не удалось открыть настройки. Откройте вручную: browser://extensions/shortcuts');
}

async function startPick(delay = 0) {
  showError('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'udc:startPick', tabId: tab.id, delay });
  if (res?.ok) window.close();
  else showError(res?.error || 'Не удалось запустить выбор элемента');
}

btnAll.addEventListener('click', () => {
  view = 'list';
  render();
});

store.onReviewsChanged(() => view === 'auto' && render());
// Сначала сверяемся с папкой, чтобы не показать на мгновение ревью, которых на диске уже нет.
store
  .migrateIfNeeded()
  .catch(() => {})
  .then(() => folder.checkFolderContents())
  .then((check) => (folderCheck = check), () => {})
  .finally(render);
