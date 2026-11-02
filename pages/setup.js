import * as store from '../lib/store.js';
import * as folder from '../lib/folder.js';
import { icon } from '../lib/icons.js';

const stateEl = document.getElementById('state');
let restored = null; // итог восстановления ревью из только что выбранной папки
// ?restore=1 — пришли из popup по кнопке «Восстановить ревью из папки»: короткий экран, папка только для чтения.
let restoreMode = new URLSearchParams(location.search).has('restore');
let restoredPicked = null; // папка, выбранная при восстановлении, в которой ревью не нашлось: её можно взять для записи
// ?grant=1 — пришли из popup по «разрешить»: браузер забыл доступ на запись, просим его по кнопке.
let grantMode = new URLSearchParams(location.search).has('grant');
let grantWritten = 0; // сколько ревью записал requestAccess — показываем в итоге
const intro = { step: document.querySelector('.step').textContent, h1: document.querySelector('h1').textContent };
function showGrantIntro(on) {
  document.querySelector('.step').textContent = on ? 'Доступ к папке' : intro.step;
  document.querySelector('h1').textContent = on ? 'Разрешите запись в папку' : intro.h1;
  document.querySelector('.grant-intro').hidden = !on;
  document.querySelector('.connect-info').hidden = on;
}
function showRestoreIntro(on) {
  document.querySelector('.step').textContent = on ? 'Восстановление' : intro.step;
  document.querySelector('h1').textContent = on ? 'Восстановите прошлые ревью' : intro.h1;
  document.querySelector('.restore-intro').hidden = !on;
  document.querySelector('.connect-info').hidden = on;
}
if (grantMode) showGrantIntro(true);
if (restoreMode) showRestoreIntro(true);

async function shortcut() {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'start-pick')?.shortcut || '';
}

function bindClose() {
  stateEl.querySelector('[data-act=close]').addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent();
    chrome.tabs.remove(tab.id);
  });
}

// Итог восстановления: коротко, что вернулось, и что запись нужно будет разрешить в окне расширения.
// Ревью не нашлось — папку можно взять для новых результатов или выбрать другую.
function renderRestored(error = '') {
  const summary = folder.importSummary(restored);
  stateEl.innerHTML = restored.found
    ? `<div class="done">
        <h2>${icon('check', 18)} Ревью восстановлены</h2>
        ${summary ? '<p class="restored"></p>' : ''}
        <p>Осталось разрешить запись, чтобы новые замечания сохранялись в папку: в окне расширения нажмите «разрешить».</p>
        <div class="actions"><button class="btn btn-primary" data-act="close">Готово</button></div>
      </div>`
    : `<div class="hint">В этой папке нет сохранённых ревью. Если это новая папка для результатов — сохраняйте их сюда.
         Если ревью лежат в другом месте — выберите ту папку.</div>
       <div class="actions">
         <button class="btn btn-primary" data-act="use">${icon('folder', 14)} Сохранять результаты сюда</button>
         <button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Выбрать другую папку</button>
       </div>
       ${error ? '<div class="error"></div>' : ''}`;
  if (summary && restored.found) stateEl.querySelector('.restored').textContent = summary;
  if (restored.found) bindClose();
  else {
    if (error) stateEl.querySelector('.error').textContent = error;
    stateEl.querySelector('[data-act=use]').addEventListener('click', useRestored);
  }
}

// «Сохранять результаты сюда»: только по клику — иначе браузер не покажет запрос разрешения на запись.
// Ошибки — через общий render(): он же навешивает обработчик на «Выбрать другую папку».
async function useRestored() {
  let state;
  try {
    state = await folder.permission(restoredPicked, true);
  } catch (e) {
    return render(`Не удалось запросить доступ: ${e.message}`);
  }
  if (state !== 'granted') return render('Браузер не дал доступ на запись. Нажмите ещё раз и выберите «Разрешить».');
  let dir;
  try {
    ({ dir } = await folder.connectResultsFolder(restoredPicked)); // уже в режиме записи
  } catch (e) {
    return render(`Не удалось подключить папку: ${e.message}`);
  }
  try {
    await folder.writeAll(dir, await store.getAllReviews());
  } catch (e) {
    await folder.setStatus({ state: 'error', error: e.message });
  }
  restoreMode = false;
  restored = null;
  restoredPicked = null;
  showRestoreIntro(false);
  render();
}

// Экран «разрешить запись»: одна кнопка, по клику браузер показывает запрос с «Разрешать всегда».
async function renderGrant(error = '') {
  const dir = await folder.getDir();
  if (!dir) {
    // Папку успели отключить — показываем обычное подключение.
    grantMode = false;
    showGrantIntro(false);
    return render(error);
  }
  const state = await folder.permission(dir).catch(() => 'prompt');
  if (state === 'granted') {
    // Доступ есть — сразу дописываем всё, что не успело сохраниться.
    const written = (await folder.flushUnsaved()) + grantWritten;
    grantWritten = 0;
    document.querySelector('h1').textContent = 'Ревью сохранены на диск';
    document.querySelector('.grant-intro').hidden = true;
    const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
    stateEl.innerHTML = status.state === 'error'
      ? `<div class="error"></div>`
      : `<div class="done">
        <h2>${icon('check', 18)} ${written ? `Записано ревью: ${written}` : 'Всё уже сохранено'}</h2>
        <p>Папка: <code class="path"></code></p>
        <p class="note">Браузер даёт расширению писать в папку, пока открыта его страница. Если изменения появятся без неё,
          окно расширения покажет «сохранить».</p>
        <div class="actions"><button class="btn btn-primary" data-act="close">Готово</button></div>
      </div>`;
    if (status.state === 'error') stateEl.querySelector('.error').textContent = `Не удалось записать: ${status.error}`;
    else {
      stateEl.querySelector('.path').textContent = `${folder.folderLabel(dir, status)}/`;
      bindClose();
    }
    return;
  }
  // Подпись — один текстовый узел: у .btn flex с gap, и кавычки отдельными узлами отъехали бы от имени папки.
  stateEl.innerHTML = `<button class="btn btn-primary btn-big" data-act="grant">${icon('folder', 18)}<span class="label"></span></button>
    ${error ? '<div class="error"></div>' : ''}`;
  stateEl.querySelector('[data-act=grant] .label').textContent = `Разрешить запись в «${dir.name}»`;
  if (error) stateEl.querySelector('.error').textContent = error;
  stateEl.querySelector('[data-act=grant]').addEventListener('click', async () => {
    let result;
    try {
      grantWritten = (await store.listReviews()).length; // requestAccess записывает все ревью
      result = await folder.requestAccess(dir);
      if (result !== 'granted') grantWritten = 0;
    } catch (e) {
      return renderGrant(`Не удалось запросить доступ: ${e.message}`);
    }
    renderGrant(result === 'granted' ? '' : 'Браузер не дал доступ. Нажмите ещё раз и выберите «Разрешать всегда» или «Разрешить один раз».');
  });
}

async function render(error = '') {
  if (grantMode) return renderGrant(error);
  if (restoreMode && restored) {
    renderRestored(error);
  } else {
    const dir = restoreMode ? null : await folder.getDir();
    const { [folder.KEY_FOLDER_STATUS]: status = {} } = await chrome.storage.local.get(folder.KEY_FOLDER_STATUS);
    if (!dir) {
      stateEl.innerHTML = `<button class="btn btn-primary btn-big" data-act="pick">${icon('folder', 18)} ${restoreMode ? 'Выбрать папку с ревью' : 'Выбрать папку uniform-reviews-results'}</button>
        ${error ? `<div class="error"></div>` : ''}`;
      if (error) stateEl.querySelector('.error').textContent = error;
    } else {
      const keys = await shortcut();
      const summary = restored ? folder.importSummary(restored) : '';
      stateEl.innerHTML = `<div class="done">
          <h2>${icon('check', 18)} Папка подключена</h2>
          <p>Результаты сохраняются в <code class="path"></code></p>
          ${summary ? `<p class="restored"></p>` : ''}
          ${
            // Подсказка нужна, только если папка пуста и записывать в неё нечего: иначе ревью в ней уже есть.
            restored && !restored.found && !restored.written && !restored.failed.length
              ? `<div class="hint">В этой папке нет сохранённых ревью. Если раньше вы сохраняли результаты в другом месте —
                  <button class="link" data-act="pick">укажите ту папку</button>, и ревью подтянутся оттуда.</div>`
              : ''
          }
          <p>Вернитесь на вкладку с сайтом и нажмите на иконку расширения → «🎯 Выбрать элемент»${keys ? ` или <code>${keys}</code>` : ''}.</p>
          <p class="note">Когда эта вкладка закроется, браузер может один раз снова спросить доступ к папке — выберите «Разрешать всегда», и он больше не спросит.</p>
          <div class="actions">
            <button class="btn btn-primary" data-act="close">Начать ревью</button>
            <button class="btn btn-light" data-act="pick">${icon('folderOpen', 14)} Сменить папку</button>
          </div>
        </div>`;
      stateEl.querySelector('.path').textContent = `${folder.folderLabel(dir, status)}/`;
      if (summary) stateEl.querySelector('.restored').textContent = summary;
      bindClose();
    }
  }
  stateEl.querySelectorAll('[data-act=pick]').forEach((btn) => btn.addEventListener('click', pick));
}

async function pick() {
  let dir;
  let picked;
  try {
    ({ dir, picked } = await folder.pickResultsFolder({ readOnly: restoreMode }));
  } catch (e) {
    if (e.name !== 'AbortError') render(`Не удалось ${restoreMode ? 'открыть' : 'подключить'} папку: ${e.message}`);
    return;
  }
  restored = null;
  restoredPicked = null;
  try {
    restored = await folder.importFromFolder(dir); // ревью, сохранённые здесь раньше (например, до переустановки расширения)
    if (restoreMode && !restored.found) {
      restoredPicked = picked;
      await folder.disconnectFolder(); // не привязывать молча папку, открытую только для чтения
    }
    // При восстановлении папка открыта только для чтения — запись разрешат позже, в окне расширения.
    if (!restoreMode) {
      const reviews = await store.getAllReviews();
      await folder.writeAll(dir, reviews);
      restored.written = reviews.length;
    }
  } catch (e) {
    if (restoreMode && !restored) return render(`Не удалось прочитать папку: ${e.message}`);
    await folder.setStatus({ state: 'error', error: e.message });
  }
  render();
}

render();
