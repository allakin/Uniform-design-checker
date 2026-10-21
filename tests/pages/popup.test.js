import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

after(closePage);

async function withReview({ issues = [], folderPerm = 'granted', review = {}, ...opts } = {}) {
  let created;
  const page = await loadPage('popup/popup', {
    ...opts,
    setup: async (env) => {
      if (folderPerm) await connectFolder(MemDir, { permission: folderPerm });
      created = await store.createReview({ title: 'Оплата', author: 'Анна', devTicketUrl: 'https://st.example.com/DEV-1', designTicketUrl: '', ...review });
      for (const i of issues) await store.addIssue(created.id, i);
      await opts.setup?.(env);
    },
  });
  return { ...page, review: created };
}

describe('popup: создание ревью', () => {
  test('без ревью сразу показывает форму создания с подсказкой по хосту вкладки', async () => {
    const { $ } = await loadPage('popup/popup');
    assert.ok($('form#create'));
    assert.equal($('#btn-all').hidden, true);
    assert.equal($('[name=title]').placeholder, 'Например: Ревью shop.example.com');
    assert.equal($('[data-act=back]'), null, 'отмены нет, если ревью ещё не было');
  });

  test('папка не подключена (например, после переустановки) — кнопка восстановления открывает страницу настройки', async () => {
    const { $, chrome } = await loadPage('popup/popup');
    assert.match($('.restore').textContent, /Уже делали ревью раньше\?/);
    $('[data-act=restore]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/setup.html?restore=1'));
  });

  test('папка подключена — кнопки восстановления нет', async () => {
    const { $ } = await loadPage('popup/popup', { setup: () => connectFolder(MemDir) });
    assert.ok($('form#create'));
    assert.equal($('.restore'), null);
  });

  test('некорректная ссылка на тикет не даёт создать ревью', async () => {
    const { $, window } = await loadPage('popup/popup');
    $('[name=devTicketUrl]').value = 'просто текст';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(20);
    assert.ok($('[name=devTicketUrl]').classList.contains('invalid'));
    assert.equal($('[name=devTicketUrl]').nextElementSibling.hidden, false);
    assert.deepEqual(await store.listReviews(), []);
  });

  test('создаёт ревью; первый запуск без папки ведёт на страницу настройки', async () => {
    const { $, window, chrome } = await loadPage('popup/popup');
    $('[name=title]').value = 'Корзина';
    $('[name=author]').value = 'Олег';
    $('[name=devTicketUrl]').value = 'st.example.com/DEV-5';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(40);
    const r = await store.getActiveReview();
    assert.equal(r.title, 'Корзина');
    assert.equal(r.author, 'Олег');
    assert.equal(r.devTicketUrl, 'https://st.example.com/DEV-5');
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/setup.html'));
    assert.equal(window.close.mock.callCount(), 1);
  });

  test('пустое название берётся из подсказки', async () => {
    const { $, window } = await loadPage('popup/popup', { setup: () => connectFolder(MemDir) });
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(40);
    assert.equal((await store.getActiveReview()).title, 'Ревью shop.example.com');
  });

  test('с папкой после создания показывает ревью, а не настройку', async () => {
    const { $, window, chrome } = await loadPage('popup/popup', { setup: () => connectFolder(MemDir) });
    $('[name=title]').value = 'X';
    $('form#create').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(60);
    assert.equal(chrome.tabs.create.mock.callCount(), 0);
    assert.equal($('.review-card .title').textContent, 'X');
  });
});

describe('popup: текущее ревью', () => {
  test('показывает название, счётчики и список групп с числом вариантов и страниц', async () => {
    const { $, $$ } = await withReview({
      issues: [
        makeIssue({ group: 'A', page: { url: 'https://shop.ru/a' } }),
        makeIssue({ group: 'A', page: { url: 'https://shop.ru/b' } }),
        makeIssue({ group: 'B', screenshot: '' }),
      ],
    });
    assert.equal($('.review-card .title').textContent, 'Оплата');
    assert.match($('.review-card .meta').textContent, /^2 группы · 3 варианта · создано .+ · Анна$/);
    assert.equal($$('.review-card .chip').length, 0, 'критичности больше нет');
    assert.deepEqual($$('.issues li .t div').map((d) => d.textContent), ['A', 'B']);
    assert.deepEqual($$('.issues li small').map((d) => d.textContent), ['2 варианта · 2 страницы', '1 вариант · 1 страница']);
    assert.equal($$('.issues li img').length, 1);
    assert.equal($$('.issues li .no-shot').length, 1);
    assert.equal($$('.issues li .diff-badge').length, 0);
  });

  test('пустое ревью: подсказка и неактивный экспорт', async () => {
    const { $ } = await withReview();
    assert.match($('.empty').textContent, /Пока пусто/);
    assert.equal($('[data-act=export]').disabled, true);
  });

  test('ссылки на тикеты: только заданные и безопасные', async () => {
    const { $$ } = await withReview({ review: { devTicketUrl: 'https://st.example.com/DEV-1', designTicketUrl: 'javascript:alert(1)' } });
    const links = $$('.tickets a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://st.example.com/DEV-1');
    assert.equal(links[0].rel, 'noopener');
  });

  test('без тикетов — кнопка «Добавить ссылки на тикеты» ведёт на страницу ревью', async () => {
    const { $, chrome, review } = await withReview({ review: { devTicketUrl: '' } });
    $('[data-act=tickets]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/review.html?id=${review.id}`));
  });

  test('HTML в названиях выводится текстом', async () => {
    const { $, document } = await withReview({ review: { title: '<img src=x onerror=alert(1)>' }, issues: [makeIssue({ group: '<b>жирный</b>' })] });
    assert.equal($('.review-card .title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(document.querySelectorAll('.review-card img, .issues b').length, 0);
  });

  test('«Выбрать элемент» запускает выбор на активной вкладке и закрывает окно', async () => {
    const { $, chrome, window } = await withReview();
    $('[data-act=pick]').click();
    await sleep(20);
    assert.deepEqual(chrome.runtime.sendMessage.mock.calls[0].arguments[0], { type: 'udc:startPick', tabId: 1, delay: 0 });
    assert.equal(window.close.mock.callCount(), 1);
  });

  test('доступа к папке нет — «Выбрать элемент» не запрашивает его из окна (там запрос не показывается) и сразу запускает выбор', async () => {
    const { $, chrome } = await withReview({ folderPerm: 'prompt' });
    $('[data-act=pick]').click();
    await sleep(40);
    assert.equal((await folder.getDir()).permission, 'prompt');
    assert.equal(chrome.runtime.sendMessage.mock.calls[0].arguments[0].type, 'udc:startPick');
  });

  test('«запросить» открывает страницу ревью; «сохранить» с доступом дописывает прямо в окне; иначе — блок папки', async () => {
    const prompt = await withReview({ folderPerm: 'prompt' });
    prompt.$('.folder-line').click();
    await sleep(20);
    assert.equal(prompt.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, prompt.chrome.runtime.getURL(`pages/review.html?id=${prompt.review.id}`));
    assert.equal((await folder.getDir()).permission, 'prompt', 'из окна доступ не запрашивается');

    const granted = await withReview();
    await sleep(20);
    assert.match(granted.$('.folder-line').textContent, /Не сохранено в «uniform-reviews-results»: 1 ревью/);
    granted.$('.folder-line').click();
    await sleep(60);
    assert.equal((await folder.getDir()).list().length, 1);
    assert.match(granted.$('.folder-line').textContent, /Сохраняется в «uniform-reviews-results»/);
    assert.equal(granted.chrome.tabs.create.mock.callCount(), 0);
    granted.$('.folder-line').click();
    assert.equal(granted.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, granted.chrome.runtime.getURL('pages/review.html#folder'));
  });

  test('«3 с» запускает выбор с задержкой', async () => {
    const { $, chrome } = await withReview();
    $('[data-act=pick-delay]').click();
    await sleep(20);
    assert.equal(chrome.runtime.sendMessage.mock.calls[0].arguments[0].delay, 3);
  });

  test('ошибка запуска выбора показывается в окне', async () => {
    const { $, chrome, window } = await withReview();
    chrome.runtime.sendMessage.mock.mockImplementation(async () => ({ ok: false, error: 'На служебных страницах браузера выбор элементов недоступен.' }));
    $('[data-act=pick]').click();
    await sleep(20);
    assert.equal($('#error').hidden, false);
    assert.match($('#error').textContent, /служебных страницах/);
    assert.equal(window.close.mock.callCount(), 0);
  });

  test('горячая клавиша показывается на кнопке; без неё — предупреждение «Назначить»', async () => {
    const withKey = await withReview();
    assert.equal(withKey.$('[data-act=pick] kbd').textContent, '⌥⇧D');
    assert.equal(withKey.$('.shortcut-warn'), null);
    const noKey = await withReview({ setup: (env) => env.chrome.commands.getAll.mock.mockImplementation(async () => [{ name: 'start-pick', shortcut: '' }]) });
    assert.ok(noKey.$('.shortcut-warn'));
    assert.equal(noKey.$('[data-act=pick] kbd'), null);
  });

  test('«Изменить горячую клавишу» открывает страницу сочетаний; при неудаче — подсказка', async () => {
    const { $, chrome } = await withReview();
    $('[data-act=shortcut]').click();
    await sleep(10);
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, 'chrome://extensions/shortcuts');
    chrome.tabs.create.mock.mockImplementation(async () => {
      throw new Error('нельзя');
    });
    $('[data-act=shortcut]').click();
    await sleep(10);
    assert.match($('#error').textContent, /browser:\/\/extensions\/shortcuts/);
  });

  test('без папки вместо выбора — блок «Подключить uniform-reviews-results»', async () => {
    const { $, chrome } = await withReview({ folderPerm: null });
    assert.equal($('[data-act=pick]'), null);
    $('[data-act=setup]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/setup.html'));
  });

  test('экспорт открывает отчёт в выбранном формате и запоминает формат', async () => {
    const { $, chrome, review, window } = await withReview({ issues: [makeIssue()] });
    const pdf = $('input[name=fmt][value=pdf]');
    pdf.checked = true;
    pdf.dispatchEvent(new window.Event('change'));
    await sleep(5);
    assert.equal(chrome.storage.local.data.get('exportFormat'), 'pdf');
    $('[data-act=export]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/report.html?id=${review.id}&action=pdf`));
  });

  test('сохранённый формат экспорта выбран по умолчанию', async () => {
    const { $ } = await withReview({ issues: [makeIssue()], setup: (env) => env.chrome.storage.local.set({ exportFormat: 'pdf' }) });
    assert.equal($('input[name=fmt]:checked').value, 'pdf');
  });

  test('клик по группе открывает её на странице ревью', async () => {
    const { $, chrome, review } = await withReview({ issues: [makeIssue()] });
    const [group] = (await store.getReview(review.id)).groups;
    $('.issues li').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/review.html?id=${review.id}#group-${group.id}`));
  });

  test('строка папки отражает состояние: сохраняется / нет доступа / ошибка / не подключена', async () => {
    const ok = await withReview({ setup: () => folder.flushUnsaved() });
    assert.match(ok.$('.folder-line').textContent, /Сохраняется в «uniform-reviews-results»/);
    // Страница ревью закрыта — доступа нет: просим запросить разрешение, несохранённое показываем в скобках
    const prompt = await withReview({ folderPerm: 'prompt' });
    assert.match(prompt.$('.folder-line').textContent, /Нужно разрешение на запись в «uniform-reviews-results» \(не сохранено: 1 ревью\): запросить/);
    assert.ok(prompt.$('.folder-line').classList.contains('warn'));
    // Доступа нет, всё уже на диске — всё равно просим запросить: новые замечания без него в папку не попадут
    const saved = await withReview({
      folderPerm: 'prompt',
      setup: async () => {
        const dir = await folder.getDir();
        dir.permission = 'granted';
        await folder.flushUnsaved();
        dir.permission = 'prompt';
      },
    });
    assert.match(saved.$('.folder-line').textContent, /^\s*Нужно разрешение на запись в «uniform-reviews-results»: запросить$/);
    assert.ok(saved.$('.folder-line').classList.contains('warn'));
    const err = await withReview({ setup: () => folder.setStatus({ state: 'error', error: 'boom' }) });
    assert.match(err.$('.folder-line').textContent, /Ошибка записи/);
    const none = await withReview({ folderPerm: null });
    assert.match(none.$('.folder-line').textContent, /подключить uniform-reviews-results/);
  });

  test('подсказка держать страницу ревью открытой: видна при подключённой папке, ссылка открывает страницу ревью', async () => {
    const { $, chrome, review } = await withReview();
    assert.equal($('.keep-open').hidden, false);
    assert.match($('.keep-open').textContent, /держите страницу ревью открытой — иначе браузер забирает разрешение на запись/);
    $('[data-act=keep-open]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL(`pages/review.html?id=${review.id}`));
    const none = await withReview({ folderPerm: null });
    assert.equal(none.$('.keep-open').hidden, true);
  });

  test('новый вариант из контент-скрипта сразу появляется в окне', async () => {
    const { $$, review } = await withReview();
    await store.addIssue(review.id, makeIssue({ group: 'Свежее' }));
    await sleep(30);
    assert.deepEqual($$('.issues li .t div').map((d) => d.textContent), ['Свежее']);
  });
});

describe('popup: сверка с папкой при открытии', () => {
  // Ревью сохранено в папку, затем папку очистили вручную.
  const clearedFolder = (extra = async () => {}) =>
    withReview({
      issues: [makeIssue()],
      setup: async () => {
        await folder.flushUnsaved();
        (await folder.getDir()).children.clear();
        await extra();
      },
    });

  test('папку очистили — вместо ревью экран «Папка пуста» со списком пропавших', async () => {
    const { $, $$ } = await clearedFolder();
    assert.equal($('.review-card'), null);
    assert.equal($('.missing-title').textContent, 'Папка «uniform-reviews-results» пуста');
    assert.deepEqual($$('.missing li .t div').map((d) => d.textContent), ['Оплата']);
    assert.match($('.missing li small').textContent, /^1 группа · 1 вариант · /);
  });

  test('«Удалить из расширения» — ревью удаляется, показывается форма нового ревью', async () => {
    const { $ } = await clearedFolder();
    $('[data-act=forget]').click();
    await sleep(40);
    assert.deepEqual(await store.listReviews(), []);
    assert.ok($('form#create'));
    assert.equal($('.restore'), null, 'папка подключена — восстанавливать нечего');
  });

  test('«Сохранить в папку заново» — ревью записывается и показывается как обычно', async () => {
    const { $ } = await clearedFolder();
    $('[data-act=resave]').click();
    await sleep(40);
    assert.equal((await folder.getDir()).list().length, 1);
    assert.equal($('.review-card .title').textContent, 'Оплата');
    assert.match($('.folder-line').textContent, /Сохраняется в «uniform-reviews-results»/);
  });

  test('пропала часть ревью — в заголовке их число, остальные не трогаются', async () => {
    const { $, $$ } = await withReview({
      setup: async () => {
        await sleep(2);
        await store.createReview({ title: 'Осталось' });
        await folder.flushUnsaved();
        const dir = await folder.getDir();
        const oplata = (await store.listReviews()).find((m) => m.title === 'Оплата');
        await dir.removeEntry(await folder.reviewFolderName(oplata), { recursive: true });
      },
    });
    assert.equal($('.missing-title').textContent, 'В папке «uniform-reviews-results» нет 1 ревью');
    assert.deepEqual($$('.missing li .t div').map((d) => d.textContent), ['Оплата']);
    $('[data-act=forget]').click();
    await sleep(40);
    assert.deepEqual((await store.listReviews()).map((m) => m.title), ['Осталось']);
    assert.equal($('.review-card .title').textContent, 'Осталось');
  });

  test('«Ревью лежат в другой папке?» открывает блок папки на странице ревью', async () => {
    const { $, chrome } = await clearedFolder();
    $('[data-act=other-folder]').click();
    assert.equal(chrome.tabs.create.mock.calls.at(-1).arguments[0].url, chrome.runtime.getURL('pages/review.html#folder'));
  });

  test('папку удалили целиком — вместо «Сохранить заново» предлагается выбрать папку', async () => {
    const { $ } = await clearedFolder(async () => {
      (await folder.getDir()).entries = async function* () {
        throw Object.assign(new Error('нет каталога'), { name: 'NotFoundError' });
      };
    });
    assert.equal($('.missing-title').textContent, 'Папки «uniform-reviews-results» больше нет');
    assert.equal($('[data-act=resave]'), null);
    assert.ok($('[data-act=other-folder]'));
  });

  test('без доступа к папке проверить нельзя — ревью показывается как раньше', async () => {
    const { $ } = await clearedFolder(async () => {
      (await folder.getDir()).permission = 'prompt';
    });
    assert.equal($('.missing'), null);
    assert.equal($('.review-card .title').textContent, 'Оплата');
  });
});

describe('popup: все ревью', () => {
  test('список ревью и переключение текущего', async () => {
    let first;
    const { $, $$ } = await loadPage('popup/popup', {
      setup: async () => {
        await connectFolder(MemDir);
        first = await store.createReview({ title: 'Первое' });
        await sleep(2);
        await store.createReview({ title: 'Второе' });
      },
    });
    assert.equal($('#btn-all').hidden, false);
    $('#btn-all').click();
    await sleep(20);
    assert.deepEqual($$('.review-list li div div').map((d) => d.textContent), ['Второе', 'Первое']);
    assert.ok($$('.review-list li')[0].classList.contains('active'));
    $$('.review-list li')[1].click();
    await sleep(30);
    assert.equal(await store.getActiveReviewId(), first.id);
    assert.equal($('.review-card .title').textContent, 'Первое');
  });

  test('ревью есть, а текущего нет (восстановили из папки) — открывается последнее изменённое, а не форма', async () => {
    const { $ } = await loadPage('popup/popup', {
      setup: async () => {
        await connectFolder(MemDir);
        await store.importReview({ id: 'a', title: 'Давнее', createdAt: 1, updatedAt: 10, issues: [] });
        await store.importReview({ id: 'b', title: 'Последнее', createdAt: 2, updatedAt: 20, issues: [] });
      },
    });
    assert.equal($('form#create'), null);
    assert.equal($('.review-card .title').textContent, 'Последнее');
    assert.equal(await store.getActiveReviewId(), 'b');
  });

  test('«Новое ревью» из списка открывает форму с отменой; ревьюер подставляется', async () => {
    const { $ } = await withReview();
    $('[data-act=new]').click();
    await sleep(20);
    assert.ok($('form#create'));
    assert.equal($('[name=author]').value, 'Анна');
    $('[data-act=back]').click();
    await sleep(20);
    assert.equal($('.review-card .title').textContent, 'Оплата');
  });
});
