import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue, makeReview } from '../helpers/env.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

after(closePage);

async function report({ action = '', withFolder = false, permission = 'granted', byId = true, issues = 2 } = {}) {
  const ctx = {};
  const page = await loadPage('pages/report', {
    setup: async () => {
      if (withFolder) ctx.root = await connectFolder(MemDir, { permission });
      ctx.review = await store.createReview({ title: 'Оплата', author: 'Анна' });
      for (let i = 0; i < issues; i++) await store.addIssue(ctx.review.id, makeIssue());
    },
  });
  // id известен только после setup — перезапускаем страницу с нужным адресом
  const query = `?${byId ? `id=${ctx.review.id}` : ''}${action ? `&action=${action}` : ''}`;
  const reloaded = await loadPage('pages/report', {
    query,
    setup: async (env) => {
      for (const [k, v] of page.chrome.storage.local.data) await env.chrome.storage.local.set({ [k]: v });
      if (ctx.root) await folder.setDir(ctx.root);
    },
  });
  await sleep(action === 'pdf' ? 400 : 60);
  return { ...reloaded, ...ctx };
}

describe('страница отчёта', () => {
  test('показывает отчёт ревью; заголовок вкладки — имя будущего PDF', async () => {
    const { $, $$, document } = await report();
    assert.equal($('h1').textContent, 'Оплата');
    assert.equal($$('section.group').length, 1);
    assert.equal($$('article.variant').length, 2);
    assert.match(document.title, /^Единообразие блоков — Оплата — \d{4}-\d{2}-\d{2}$/);
    assert.ok($('#report-style').textContent.includes('.variant'));
    assert.ok($('.lb'), 'просмотрщик скриншотов подключён');
    assert.match($('#btn-html').textContent, /Скачать HTML/);
  });

  test('без id открывает текущее ревью', async () => {
    const { $ } = await report({ byId: false });
    assert.equal($('h1').textContent, 'Оплата');
  });

  test('неизвестное ревью — сообщение и неактивные кнопки', async () => {
    const page = await loadPage('pages/report', { query: '?id=nope' });
    assert.match(page.$('#report').textContent, /Ревью не найдено/);
    assert.ok(page.$$('.tb-btn').every((b) => b.disabled));
  });

  test('«Скачать HTML» скачивает самодостаточный файл', async () => {
    const { $, downloads } = await report();
    $('#btn-html').click();
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^Единообразие блоков — Оплата — \d{4}-\d{2}-\d{2}\.html$/);
    assert.match(downloads[0].href, /^blob:/);
    assert.equal($('#status').textContent, 'HTML-файл скачан');
  });

  test('action=html с подключённой папкой — отчёт пишется в uniform-reviews-results, а не в «Загрузки»', async () => {
    const { $, root, downloads } = await report({ action: 'html', withFolder: true });
    const [sub] = root.list();
    assert.ok(root.has(`${sub}/Отчёт.html`));
    assert.equal(downloads.length, 0);
    assert.equal($('#status').textContent, `Сохранено: uniform-reviews-results/${sub}/Отчёт.html`);
  });

  test('action=html без доступа к папке — обычное скачивание', async () => {
    const { downloads, root } = await report({ action: 'html', withFolder: true, permission: 'prompt' });
    assert.equal(downloads.length, 1);
    assert.deepEqual(root.list(), []);
  });

  test('action=html: ошибка записи в папку — сообщение и скачивание', async () => {
    const page = await report({ withFolder: true });
    await sleep(30);
    page.root.children.clear(); // первая страница уже дописала ревью на диск — начинаем с пустой папки
    page.root.failWrites = 'Диск переполнен';
    const again = await loadPage('pages/report', {
      query: `?id=${page.review.id}&action=html`,
      setup: async (env) => {
        for (const [k, v] of page.chrome.storage.local.data) await env.chrome.storage.local.set({ [k]: v });
        await folder.setDir(page.root);
      },
    });
    await sleep(60);
    assert.equal(again.downloads.length, 1);
    assert.equal(again.$('#status').textContent, 'HTML-файл скачан');
  });

  test('action=pdf открывает окно печати с подсказкой', async () => {
    const { window, $ } = await report({ action: 'pdf' });
    assert.equal(window.print.mock.callCount(), 1);
    assert.match($('#status').textContent, /Сохранить как PDF/);
  });

  test('«Сохранить в PDF» вызывает печать', async () => {
    const { window, $ } = await report();
    $('#btn-pdf').click();
    await sleep(20);
    assert.equal(window.print.mock.callCount(), 1);
  });
});

describe('страница первичной настройки', () => {
  test('без папки — кнопка выбора', async () => {
    const { $ } = await loadPage('pages/setup');
    assert.match($('[data-act=pick]').textContent, /Выбрать папку uniform-reviews-results/);
    assert.equal($('.done'), null);
  });

  test('выбор папки расширения подключает uniform-reviews-results внутри и сохраняет существующие ревью', async () => {
    const page = await loadPage('pages/setup', { setup: () => store.createReview({ title: 'Уже было' }) });
    const ext = new MemDir('Uniform design checker');
    globalThis.showDirectoryPicker = async () => ext;
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.match(ext.list('uniform-reviews-results')[0], /^Уже было — /);
    assert.match(page.$('.done h2').textContent, /Папка подключена/);
    assert.equal(page.$('.path').textContent, 'Uniform design checker/uniform-reviews-results/');
    assert.match(page.$('.done').textContent, /⌥⇧D/);
  });

  test('режим восстановления (?restore=1): свой заголовок, пояснение и кнопка', async () => {
    const { $ } = await loadPage('pages/setup', { query: '?restore=1' });
    assert.equal($('h1').textContent, 'Восстановите прошлые ревью');
    assert.equal($('.step').textContent, 'Восстановление');
    assert.equal($('.restore-intro').hidden, false);
    assert.equal($('.connect-info').hidden, true, 'длинная инструкция первого запуска скрыта');
    assert.match($('.restore-intro').textContent, /только для чтения/);
    assert.match($('[data-act=pick]').textContent, /Выбрать папку с ревью/);
    const plain = await loadPage('pages/setup');
    assert.equal(plain.$('.restore-intro').hidden, true);
    assert.equal(plain.$('.connect-info').hidden, false);
    assert.equal(plain.$('h1').textContent, 'Подключите папку uniform-reviews-results');
  });

  test('разрешение записи (?grant=1): кнопка запрашивает доступ, дописывает ревью и показывает итог', async () => {
    let root;
    const page = await loadPage('pages/setup', {
      query: '?grant=1',
      setup: async () => {
        root = await connectFolder(MemDir, { permission: 'prompt' });
        await store.createReview({ title: 'Ждало доступа' });
      },
    });
    assert.equal(page.$('h1').textContent, 'Разрешите запись в папку');
    assert.equal(page.$('.grant-intro').hidden, false);
    assert.equal(page.$('.connect-info').hidden, true);
    assert.equal(page.$('[data-act=grant] .label').textContent, 'Разрешить запись в «uniform-reviews-results»');
    assert.equal(page.$('[data-act=grant]').children.length, 2, 'иконка и одна подпись — без лишних flex-элементов');
    page.$('[data-act=grant]').click();
    await sleep(80);
    assert.equal(root.permission, 'granted');
    assert.match(root.list()[0], /^Ждало доступа — /);
    assert.equal(page.$('h1').textContent, 'Ревью сохранены на диск');
    assert.match(page.$('.done h2').textContent, /Записано ревью: 1/);
    assert.match(page.$('.done .note').textContent, /пока открыта его страница/);
    assert.deepEqual(await folder.unsavedReviews(), []);
    page.$('[data-act=close]').click();
    await sleep(20);
    assert.equal(page.chrome.tabs.remove.mock.callCount(), 1);
  });

  test('?grant=1, доступ уже есть (браузер вернул его странице сам) — без кнопки сразу дописывает несохранённое', async () => {
    let root;
    const page = await loadPage('pages/setup', {
      query: '?grant=1',
      setup: async () => {
        root = await connectFolder(MemDir);
        await store.createReview({ title: 'Замечания с сайта' });
      },
    });
    await sleep(80);
    assert.equal(page.$('[data-act=grant]'), null);
    assert.match(root.list()[0], /^Замечания с сайта — /);
    assert.match(page.$('.done h2').textContent, /Записано ревью: 1/);
    assert.deepEqual(await folder.unsavedReviews(), []);
  });

  test('разрешение записи: отказ — кнопка остаётся с подсказкой; без папки — обычное подключение', async () => {
    const page = await loadPage('pages/setup', {
      query: '?grant=1',
      setup: async () => {
        await folder.setDir(new MemDir('uniform-reviews-results', { permission: 'prompt', grantOnRequest: false }));
      },
    });
    page.$('[data-act=grant]').click();
    await sleep(60);
    assert.ok(page.$('[data-act=grant]'));
    assert.match(page.$('.error').textContent, /Браузер не дал доступ/);

    const none = await loadPage('pages/setup', { query: '?grant=1' });
    await sleep(30);
    assert.equal(none.$('h1').textContent, 'Подключите папку uniform-reviews-results');
    assert.match(none.$('[data-act=pick]').textContent, /Выбрать папку uniform-reviews-results/);
  });

  test('режим восстановления: папка открывается только для чтения, ревью возвращаются, на диск ничего не пишется', async () => {
    const saved = new MemDir('uniform-reviews-results');
    await folder.writeReview(saved, { id: 'old-r', title: 'Прошлое', createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 1), issues: [makeIssue()] });
    const before = saved.at(saved.list()[0]).list();
    const page = await loadPage('pages/setup', { query: '?restore=1' });
    saved.failWrites = 'только чтение'; // любая попытка создать файл упадёт
    let opts;
    globalThis.showDirectoryPicker = async (o) => ((opts = o), saved);
    try {
      page.$('[data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(opts.mode, 'read');
    assert.match(page.$('.done h2').textContent, /Ревью восстановлены/);
    assert.equal(page.$('.restored').textContent, 'Восстановлено ревью из папки: 1.');
    assert.match(page.$('.done').textContent, /Осталось разрешить запись.*нажмите «разрешить»/);
    assert.equal((await store.getReview('old-r')).title, 'Прошлое');
    assert.equal(await store.getActiveReviewId(), 'old-r');
    assert.deepEqual(saved.at(saved.list()[0]).list(), before);
    assert.notEqual(page.chrome.storage.local.data.get(folder.KEY_FOLDER_STATUS).state, 'error');
    page.$('[data-act=close]').click();
    await sleep(20);
    assert.equal(page.chrome.tabs.remove.mock.callCount(), 1);
  });

  test('режим восстановления: в папке нет ревью — предлагает выбрать другую', async () => {
    const page = await loadPage('pages/setup', { query: '?restore=1' });
    const other = new MemDir('Старые');
    await folder.writeReview(other, { id: 'o', title: 'Нашлось', createdAt: 0, updatedAt: 0, issues: [] });
    const picks = [new MemDir('uniform-reviews-results'), other];
    globalThis.showDirectoryPicker = async () => picks.shift();
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
      assert.match(page.$('.hint').textContent, /нет сохранённых ревью/);
      assert.match(page.$('[data-act=pick]').textContent, /Выбрать другую папку/);
      page.$('[data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.match(page.$('.done h2').textContent, /Ревью восстановлены/);
    assert.equal((await store.getReview('o')).title, 'Нашлось');
  });

  test('первый запуск: выбрана папка расширения, в её uniform-reviews-results лежат прошлые ревью — подтягиваются сразу', async () => {
    const ext = new MemDir('Uniform design checker');
    const results = await ext.getDirectoryHandle('uniform-reviews-results', { create: true });
    await folder.writeReview(results, { id: 'prev', title: 'Прошлое ревью', createdAt: Date.UTC(2026, 9, 10), updatedAt: Date.UTC(2026, 9, 11), issues: [makeIssue()] });
    const page = await loadPage('pages/setup'); // новое окружение — как после переустановки
    globalThis.showDirectoryPicker = async () => ext;
    try {
      page.$('[data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(page.$('.path').textContent, 'Uniform design checker/uniform-reviews-results/');
    assert.equal(page.$('.restored').textContent, 'Восстановлено ревью из папки: 1.');
    assert.equal((await store.getReview('prev')).issues.length, 1);
    assert.equal(await store.getActiveReviewId(), 'prev');
    assert.deepEqual(results.list(), ['Прошлое ревью — 2026-10-10'], 'дубликат папки не создаётся');
  });

  test('после переустановки: выбор папки с сохранёнными ревью восстанавливает их', async () => {
    const saved = new MemDir('Мои ревью'); // папка с произвольным именем — используется как есть
    await folder.writeReview(saved, makeReview({ id: 'old-1', title: 'Старое ревью', createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 2), issues: [makeIssue({ group: 'Кнопка', note: 'серая' })] }));
    const page = await loadPage('pages/setup'); // новое окружение — chrome.storage пуст
    globalThis.showDirectoryPicker = async () => saved;
    try {
      page.$('[data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(page.$('.path').textContent, 'Мои ревью/');
    assert.equal(page.$('.restored').textContent, 'Восстановлено ревью из папки: 1.');
    assert.equal(page.$('.hint'), null);
    const restored = await store.getReview('old-1');
    assert.equal(restored.groups[0].title, 'Кнопка');
    assert.equal(restored.issues[0].note, 'серая');
    assert.match(restored.issues[0].screenshot, /^data:image\/png;base64,/);
    assert.deepEqual(saved.list(), ['Старое ревью — 2026-10-01'], 'дубликат папки не создаётся');
  });

  test('в выбранной папке нет сохранённых ревью — предлагает указать другую', async () => {
    const page = await loadPage('pages/setup');
    const empty = new MemDir('uniform-reviews-results');
    const other = new MemDir('Старые ревью');
    await folder.writeReview(other, { id: 'old-2', title: 'Найдено', createdAt: 0, updatedAt: 0, issues: [] });
    const picks = [empty, other];
    globalThis.showDirectoryPicker = async () => picks.shift();
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
      assert.match(page.$('.hint').textContent, /нет сохранённых ревью/);
      assert.equal(page.$('.restored'), null);
      page.$('.hint [data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(page.$('.hint'), null);
    assert.equal(page.$('.path').textContent, 'Старые ревью/');
    assert.equal((await store.getReview('old-2')).title, 'Найдено');
  });

  test('отмена системного диалога — без ошибки; прочие ошибки показываются', async () => {
    const page = await loadPage('pages/setup');
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    page.$('[data-act=pick]').click();
    await sleep(30);
    assert.equal(page.$('.error'), null);
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('Системная папка'), { name: 'SecurityError' });
    };
    page.$('[data-act=pick]').click();
    await sleep(30);
    delete globalThis.showDirectoryPicker;
    assert.equal(page.$('.error').textContent, 'Не удалось подключить папку: Системная папка');
  });

  test('уже подключена — путь, «Начать ревью» закрывает вкладку, «Сменить папку» доступна', async () => {
    const page = await loadPage('pages/setup', { setup: () => connectFolder(MemDir) });
    assert.equal(page.$('.path').textContent, 'uniform-reviews-results/');
    assert.ok(page.$('[data-act=pick]'));
    page.$('[data-act=close]').click();
    await sleep(20);
    assert.equal(page.chrome.tabs.remove.mock.callCount(), 1);
  });

  test('ошибка первичного сохранения не мешает подключению — статус error', async () => {
    const page = await loadPage('pages/setup', { setup: async () => store.addIssue((await store.createReview({ title: 'R' })).id, makeIssue()) });
    const dir = new MemDir('uniform-reviews-results');
    dir.failWrites = 'Только чтение';
    globalThis.showDirectoryPicker = async () => dir;
    try {
      page.$('[data-act=pick]').click();
      await sleep(120);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.ok(page.$('.done'));
    assert.equal(page.chrome.storage.local.data.get(folder.KEY_FOLDER_STATUS).state, 'error');
  });
});
