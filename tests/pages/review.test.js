import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, closePage, connectFolder, sleep } from '../helpers/page.js';
import { MemDir } from '../helpers/fs.js';
import { makeIssue } from '../helpers/env.js';
import { readFileSync } from 'node:fs';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';
import { editorHtml, mountEditor } from '../../pages/md-editor.js';

after(closePage);

// Три ревью: «Альфа» (группы «Кнопка» и «Шапка», по варианту), «Бета» (текущее, пустое), «Гамма» (1 вариант). Создаются по очереди.
async function seed({ withFolder = true, permission = 'granted' } = {}) {
  const ctx = {};
  const page = await loadPage('pages/review', {
    setup: async () => {
      if (withFolder) ctx.root = await connectFolder(MemDir, { permission });
      ctx.alpha = await store.createReview({ title: 'Альфа', author: 'Анна', devTicketUrl: 'https://st.example.com/DEV-1' });
      ctx.a1 = (await store.addIssue(ctx.alpha.id, makeIssue({ group: 'Кнопка', note: 'серая', page: { url: 'https://shop.ru/cart?x=1', title: 'Корзина' } }))).issue;
      ctx.a2 = (await store.addIssue(ctx.alpha.id, makeIssue({ group: 'Шапка' }))).issue;
      [ctx.g1, ctx.g2] = (await store.getReview(ctx.alpha.id)).groups;
      await sleep(3);
      ctx.gamma = await store.createReview({ title: 'Гамма' });
      await store.addIssue(ctx.gamma.id, makeIssue({ group: 'Футер' }));
      await sleep(3);
      ctx.beta = await store.createReview({ title: 'Бета' });
    },
  });
  return { ...page, ...ctx };
}

const titles = ($$) => $$('#review-list li[data-id] .t').map((t) => t.textContent);
const openReview = async (page, review) => {
  page.$(`#review-list li[data-id="${review.id}"]`).click();
  await sleep(30);
};

describe('список ревью', () => {
  test('по умолчанию — недавно изменённые, открыто текущее ревью', async () => {
    const { $$, $ } = await seed();
    assert.deepEqual(titles($$), ['Бета', 'Гамма', 'Альфа']);
    assert.equal($('#review-list li.current .t').textContent, 'Бета');
    assert.ok($('#review-list li.current .badge'));
    assert.equal($('.title-input').value, 'Бета');
    assert.equal($('#found').textContent, 'Всего: 3');
  });

  test('сортировки: новые, старые, по названию, по числу вариантов; выбор запоминается', async () => {
    const { $, $$, window, chrome } = await seed();
    const sort = async (v) => {
      $('#sort').value = v;
      $('#sort').dispatchEvent(new window.Event('change'));
      await sleep(30);
      return titles($$);
    };
    assert.deepEqual(await sort('created-asc'), ['Альфа', 'Гамма', 'Бета']);
    assert.deepEqual(await sort('created-desc'), ['Бета', 'Гамма', 'Альфа']);
    assert.deepEqual(await sort('title-asc'), ['Альфа', 'Бета', 'Гамма']);
    assert.deepEqual(await sort('issues-desc'), ['Альфа', 'Гамма', 'Бета']);
    assert.equal(chrome.storage.local.data.get('reviewSort'), 'issues-desc');
  });

  test('сохранённая сортировка применяется при открытии', async () => {
    const page = await loadPage('pages/review', {
      setup: async (env) => {
        await env.chrome.storage.local.set({ reviewSort: 'title-asc' });
        await store.createReview({ title: 'Я' });
        await store.createReview({ title: 'А' });
      },
    });
    assert.equal(page.$('#sort').value, 'title-asc');
    assert.deepEqual(titles(page.$$), ['А', 'Я']);
  });

  test('поиск по названию, ревьюеру, тикетам, группам, заметкам и страницам; несколько слов; Esc очищает', async () => {
    const { $, $$, input, key } = await seed();
    const search = async (q) => {
      input($('#search'), q);
      await sleep(160);
      return titles($$);
    };
    assert.deepEqual(await search('гам'), ['Гамма']);
    assert.equal($('#found').textContent, 'Найдено: 1 из 3');
    assert.deepEqual(await search('АННА'), ['Альфа']);
    assert.deepEqual(await search('dev-1'), ['Альфа']);
    assert.deepEqual(await search('футер'), ['Гамма']);
    assert.deepEqual(await search('корзина'), ['Альфа']);
    assert.deepEqual(await search('серая'), ['Альфа']);
    assert.deepEqual(await search('кнопка шапка'), ['Альфа']);
    assert.deepEqual(await search('кнопка футер'), []);
    assert.equal($('#review-list .empty-list').textContent, 'Ничего не найдено');
    key($('#search'), 'Escape');
    await sleep(160);
    assert.equal($('#search').value, '');
    assert.equal(titles($$).length, 3);
  });

  test('переход по ревью меняет адрес и содержимое', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    assert.equal(page.$('.title-input').value, 'Альфа');
    assert.equal(new URL(page.window.location.href).searchParams.get('id'), page.alpha.id);
    assert.equal(page.$$('section.group').length, 2);
    assert.equal(page.$$('article.variant').length, 2);
  });

  test('в списке ревью — число групп и вариантов', async () => {
    const { $ } = await seed();
    assert.match($(`#review-list li[data-id] small`).textContent, /^0 групп · 0 вариантов · /);
    assert.match([...$('#review-list').querySelectorAll('small')].at(-1).textContent, /^2 группы · 2 варианта · /);
  });

  test('без ревью — заглушка', async () => {
    const { $ } = await loadPage('pages/review');
    assert.equal($('#review-list .empty-list').textContent, 'Ревью пока нет');
    assert.match($('#main').textContent, /Ревью не выбрано/);
  });

  test('id из адреса открывает нужное ревью, даже если оно не текущее', async () => {
    const page = await loadPage('pages/review', {
      query: '?id=from-link',
      setup: async (env) => {
        await store.createReview({ title: 'Текущее' });
        const now = Date.now();
        await env.chrome.storage.local.set({
          'review:from-link': { id: 'from-link', title: 'Из ссылки', author: '', createdAt: now, updatedAt: now, issues: [] },
          reviewIndex: [...(await store.listReviews()), { id: 'from-link', title: 'Из ссылки', author: '', createdAt: now, updatedAt: now, issueCount: 0 }],
        });
      },
    });
    assert.equal(page.$('.title-input').value, 'Из ссылки');
    assert.ok(page.$('[data-act=activate]'));
  });
});

describe('редактирование ревью', () => {
  test('название, ревьюер и тикеты сохраняются автоматически', async () => {
    const page = await seed();
    const { $, input } = page;
    input($('.title-input'), 'Бета 2');
    input($('.author-input'), 'Олег');
    input($('[data-field=review-designTicketUrl]'), 'figma.com/file/1');
    await sleep(500);
    const r = await store.getReview(page.beta.id);
    assert.equal(r.title, 'Бета 2');
    assert.equal(r.author, 'Олег');
    assert.equal(r.designTicketUrl, 'https://figma.com/file/1');
    const open = $('[data-open=designTicketUrl]');
    assert.equal(open.hidden, false);
    assert.equal(open.href, 'https://figma.com/file/1');
  });

  test('пустое название → «Дизайн-ревью»; некорректный тикет не сохраняется и подсвечен', async () => {
    const page = await seed();
    const { $, input } = page;
    input($('.title-input'), '   ');
    input($('[data-field=review-devTicketUrl]'), 'не ссылка');
    await sleep(500);
    const r = await store.getReview(page.beta.id);
    assert.equal(r.title, 'Дизайн-ревью');
    assert.equal(r.devTicketUrl, '');
    assert.ok($('[data-field=review-devTicketUrl]').classList.contains('invalid'));
  });

  test('«Сделать текущим» переключает ревью для новых блоков', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('[data-act=activate]').click();
    await sleep(30);
    assert.equal(await store.getActiveReviewId(), page.alpha.id);
    assert.match(page.$('.active-note').textContent, /Новые блоки попадают в это ревью/);
  });

  test('экспорт HTML/PDF открывает страницу отчёта; без вариантов кнопки неактивны', async () => {
    const page = await seed();
    assert.equal(page.$('[data-act=html]').disabled, true);
    await openReview(page, page.alpha);
    page.$('[data-act=pdf]').click();
    assert.equal(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, page.chrome.runtime.getURL(`pages/report.html?id=${page.alpha.id}&action=pdf`));
    page.$('[data-act=html]').click();
    assert.match(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, /action=html$/);
  });

  test('«Новое ревью» через диалог: название и ревьюер текущего', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('#btn-new').click();
    const field = page.$('#danger .danger-input');
    assert.equal(page.$('#danger').open, true);
    assert.equal(field.value, 'Дизайн-ревью');
    field.value = 'Новое из диалога';
    page.key(field, 'Enter');
    await sleep(40);
    const active = await store.getActiveReview();
    assert.equal(active.title, 'Новое из диалога');
    assert.equal(active.author, 'Анна');
    assert.equal(page.$('.title-input').value, 'Новое из диалога');
  });

  test('отмена диалога нового ревью ничего не создаёт', async () => {
    const page = await seed();
    page.$('#btn-new').click();
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await store.listReviews()).length, 3);
  });
});

describe('группы и варианты', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const group = (page, g) => page.$(`[data-group="${g.id}"]`);
  const card = (page, issue) => page.$(`[data-issue="${issue.id}"]`);
  const confirm = async (page, ok = true) => {
    await sleep(20);
    page.$(`#danger button[value=${ok ? 'ok' : 'cancel'}]`).click();
    await sleep(40);
  };

  test('карточки групп: номер, название, число вариантов и страниц, порядок', async () => {
    const page = await alphaPage();
    const g = group(page, page.g1);
    assert.equal(g.querySelector('.group-num').textContent, '#1');
    assert.equal(g.querySelector('.group-head [data-field=title]').value, 'Кнопка');
    assert.equal(g.querySelector('.group-stats').textContent, '1 вариант · 1 страница');
    assert.equal(g.querySelector('[data-act=up]').disabled, true);
    assert.equal(group(page, page.g2).querySelector('[data-act=down]').disabled, true);
    assert.equal(page.$$('.summary .chip').length, 0, 'критичности больше нет');
    assert.equal(page.$('.meta').textContent.split(' · ').slice(1).join(' · '), '2 группы · 2 варианта');
  });

  test('вариант: скриншот, ссылка на страницу, где он снят, заметка; без селектора, стилей и даты', async () => {
    const page = await alphaPage();
    const c = card(page, page.a1);
    assert.equal(c.closest('[data-group]').dataset.group, page.g1.id);
    assert.equal(c.querySelector('.num').textContent, 'Вариант 1');
    assert.equal(c.querySelector('.shot img').src, page.a1.screenshot);
    const link = c.querySelector('.page a');
    assert.equal(link.href, 'https://shop.ru/cart?x=1');
    assert.equal(link.textContent, 'Корзина');
    assert.equal(link.target, '_blank');
    assert.equal(c.querySelector('.page small').textContent, 'shop.ru/cart');
    assert.equal(c.querySelector('[data-field=note]').value, 'серая');
    assert.doesNotMatch(c.textContent, /Снято/);
    assert.doesNotMatch(c.textContent, /Элемент|main > \.card/);
    assert.equal(c.querySelector('details.specs'), null);
    assert.equal(c.id, page.a1.id, 'якорь для ссылок из окна расширения');
  });

  test('правка группы сохраняется: название, описание, макет; некорректная ссылка — нет', async () => {
    const page = await alphaPage();
    const g = group(page, page.g1);
    page.input(g.querySelector('[data-field=title]'), 'Кнопка «Удалить»');
    page.input(g.querySelector('[data-field=mockupUrl]'), 'figma.com/design/abc');
    await sleep(500);
    let saved = (await store.getReview(page.alpha.id)).groups[0];
    assert.equal(saved.title, 'Кнопка «Удалить»');
    assert.equal(saved.mockupUrl, 'https://figma.com/design/abc');
    page.input(g.querySelector('[data-field=mockupUrl]'), 'это не ссылка');
    await sleep(500);
    saved = (await store.getReview(page.alpha.id)).groups[0];
    assert.equal(saved.mockupUrl, 'https://figma.com/design/abc');
    assert.ok(g.querySelector('[data-field=mockupUrl]').classList.contains('invalid'));
    assert.ok(page.$('.saved').classList.contains('show'));
  });

  test('пустое название группы → «Без названия»', async () => {
    const page = await alphaPage();
    page.input(group(page, page.g1).querySelector('[data-field=title]'), '');
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).groups[0].title, 'Без названия');
  });

  test('перестановка групп вверх/вниз', async () => {
    const page = await alphaPage();
    group(page, page.g2).querySelector('[data-act=up]').click();
    await sleep(40);
    assert.deepEqual((await store.getReview(page.alpha.id)).groups.map((g) => g.title), ['Шапка', 'Кнопка']);
    assert.equal(group(page, page.g2).querySelector('.group-num').textContent, '#1');
    group(page, page.g2).querySelector('[data-act=down]').click();
    await sleep(40);
    assert.deepEqual((await store.getReview(page.alpha.id)).groups.map((g) => g.title), ['Кнопка', 'Шапка']);
  });

  test('удаление группы — только после подтверждения, вместе с вариантами', async () => {
    const page = await alphaPage();
    group(page, page.g1).querySelector('.group-head [data-act=delete]').click();
    await sleep(20);
    assert.match(page.$('#danger .danger-q').textContent, /Удалить группу «Кнопка»\?/);
    assert.match(page.$('#danger .danger-alert li').textContent, /^1 вариант со скриншотами/);
    await confirm(page, false);
    assert.equal((await store.getReview(page.alpha.id)).groups.length, 2);
    group(page, page.g1).querySelector('.group-head [data-act=delete]').click();
    await confirm(page);
    const after = await store.getReview(page.alpha.id);
    assert.deepEqual(after.groups.map((g) => g.title), ['Шапка']);
    assert.deepEqual(after.issues.map((i) => i.id), [page.a2.id]);
    assert.equal(page.$$('section.group').length, 1);
  });

  test('«Новая группа» через диалог создаёт пустую группу; отмена — ничего', async () => {
    const page = await alphaPage();
    page.$('[data-act=add-group]').click();
    await confirm(page, false);
    assert.equal((await store.getReview(page.alpha.id)).groups.length, 2);
    page.$('[data-act=add-group]').click();
    await sleep(20);
    page.$('#danger .danger-input').value = 'Модалка подтверждения';
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    const groups = (await store.getReview(page.alpha.id)).groups;
    assert.equal(groups.at(-1).title, 'Модалка подтверждения');
    assert.match(group(page, groups.at(-1)).querySelector('.group-empty').textContent, /пока нет вариантов/);
  });

  test('заметка варианта сохраняется', async () => {
    const page = await alphaPage();
    page.input(card(page, page.a1).querySelector('[data-field=note]'), '  радиус 4px  ');
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).issues[0].note, 'радиус 4px');
  });

  test('перенос варианта в другую группу и в новую', async () => {
    const page = await alphaPage();
    const move = (issue, value) => {
      const sel = card(page, issue).querySelector('[data-act=move]');
      assert.deepEqual([...sel.options].map((o) => o.value).filter(Boolean).length >= 2, true);
      sel.value = value;
      sel.dispatchEvent(new page.window.Event('change'));
    };
    assert.deepEqual([...card(page, page.a1).querySelectorAll('[data-act=move] option')].map((o) => o.textContent), ['Перенести…', 'Шапка', 'Новая группа…']);
    move(page.a1, page.g2.id);
    await sleep(60);
    let r = await store.getReview(page.alpha.id);
    assert.deepEqual(r.issues.map((i) => i.groupId), [page.g2.id, page.g2.id]);
    assert.equal(group(page, page.g2).querySelectorAll('article.variant').length, 2);
    assert.match(group(page, page.g1).querySelector('.group-empty').textContent, /пока нет вариантов/);

    move(page.a1, '__new');
    await sleep(20);
    page.$('#danger .danger-input').value = 'Кнопка серая';
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    r = await store.getReview(page.alpha.id);
    assert.equal(r.groups.find((g) => g.id === r.issues.find((i) => i.id === page.a1.id).groupId).title, 'Кнопка серая');
  });

  test('удаление варианта — только после подтверждения', async () => {
    const page = await alphaPage();
    card(page, page.a1).querySelector('[data-act=delete]').click();
    await sleep(20);
    assert.equal(page.$('#danger .danger-q').textContent, 'Удалить вариант?');
    assert.match(page.$('#danger .danger-alert li').textContent, /shop\.ru\/cart/);
    await confirm(page, false);
    assert.equal((await store.getReview(page.alpha.id)).issues.length, 2);
    card(page, page.a1).querySelector('[data-act=delete]').click();
    await confirm(page);
    assert.deepEqual((await store.getReview(page.alpha.id)).issues.map((i) => i.id), [page.a2.id]);
    assert.equal(page.$$('article.variant').length, 1);
  });

  test('без сравнения стилей и цветной полоски; описание и макет — друг под другом во всю ширину', async () => {
    const page = await alphaPage();
    const g = group(page, page.g1);
    assert.equal(g.className, 'group');
    assert.equal(g.querySelector('table.diff, .diff-field'), null);
    const fields = [...g.querySelectorAll('.group-fields > .field .field-label')].map((l) => l.textContent);
    assert.deepEqual(fields, ['Описание', 'Ссылка на макет']);
    const css = readFileSync(new URL('../../pages/review.css', import.meta.url), 'utf8');
    assert.match(css, /\.group-fields \{ display: flex; flex-direction: column;/);
    assert.doesNotMatch(css, /\.group::before/);
  });

  test('клик по скриншоту открывает просмотрщик; листаются варианты своей группы', async () => {
    let g;
    const page = await loadPage('pages/review', {
      setup: async () => {
        const rid = (await store.createReview({ title: 'R' })).id;
        for (let k = 0; k < 3; k++) await store.addIssue(rid, makeIssue({ group: 'Кнопка' }));
        await store.addIssue(rid, makeIssue({ group: 'Другая' }));
        g = (await store.getReview(rid)).groups;
      },
    });
    const box = page.$('.lb');
    assert.equal(box.hidden, true);
    page.$(`[data-group="${g[0].id}"] .shot img`).click();
    assert.equal(box.hidden, false);
    assert.equal(box.querySelector('.lb-count').textContent, '1 / 3');
    assert.equal(box.querySelector('.lb-cap').textContent, 'Кнопка · вариант 1');
    page.key(page.document, 'Escape');
    assert.equal(box.hidden, true);
  });

  test('HTML в данных вариантов и групп выводится текстом', async () => {
    let rid;
    const page = await loadPage('pages/review', {
      setup: async () => {
        rid = (await store.createReview({ title: '<b>R</b>' })).id;
        await store.addIssue(rid, makeIssue({ group: '<img src=x onerror=alert(1)>', note: '<i>n</i>', screenshotNote: '<script>x</script>', element: { selector: '<i>', width: 1, height: 1 }, page: { url: 'https://a.ru', title: '<u>t</u>' } }));
      },
    });
    assert.equal(page.$('.group-head [data-field=title]').value, '<img src=x onerror=alert(1)>');
    assert.equal(page.$('[data-field=note]').value, '<i>n</i>');
    assert.equal(page.document.querySelectorAll('#main img[onerror], #main script, #main u').length, 0);
    assert.equal(page.$('#review-list .t').textContent, '<b>R</b>');
  });

  test('варианты, потерявшие группу, при открытии попадают в настоящую группу «Без группы»', async () => {
    const page = await loadPage('pages/review', {
      setup: async (env) => {
        const rid = (await store.createReview({ title: 'R' })).id;
        await store.addIssue(rid, makeIssue({ group: 'Кнопка' }));
        const raw = env.chrome.storage.local.data.get(`review:${rid}`);
        raw.issues[0].groupId = 'gone';
        env.chrome.storage.local.data.set(`review:${rid}`, raw);
      },
    });
    const group = (await store.getAllReviews())[0].groups.find((g) => g.title === 'Без группы');
    assert.ok(group);
    const card = page.$(`[data-group="${group.id}"]`);
    assert.equal(card.querySelector('.group-head [data-field=title]').value, 'Без группы', 'её можно переименовать');
    assert.equal(card.querySelectorAll('article.variant').length, 1);
    assert.equal(page.$('[data-group=""]'), null);
  });

  test('новые варианты из контент-скрипта появляются без перезагрузки', async () => {
    const page = await seed();
    await store.addIssue(page.beta.id, makeIssue({ group: 'Только что' }));
    await sleep(1100);
    await store.addIssue(page.beta.id, makeIssue({ group: 'Только что' }));
    await sleep(40);
    assert.equal(page.$$('section.group').length, 1);
    assert.equal(page.$$('article.variant').length, 2);
  });
});

describe('удаление ревью', () => {
  test('из шапки: подтверждение со списком того, что удалится, включая папку на диске', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    const sub = await folder.writeReview(page.root, await store.getReview(page.alpha.id));
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    const dlg = page.$('#danger');
    assert.match(dlg.querySelector('.danger-q').textContent, /Удалить ревью «Альфа»\?/);
    const items = [...dlg.querySelectorAll('.danger-alert li')].map((li) => li.textContent);
    assert.match(items[0], /^2 варианта блоков со скриншотами/);
    assert.equal(items[1], `папка uniform-reviews-results/${sub} на диске — Отчёт.html, review.json и скриншоты`);
    dlg.querySelector('button[value=ok]').click();
    await sleep(60);
    assert.equal(await store.getReview(page.alpha.id), null);
    assert.ok(!page.root.has(sub));
    assert.deepEqual(titles(page.$$), ['Бета', 'Гамма']);
  });

  test('отмена ничего не удаляет', async () => {
    const page = await seed();
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger button[value=cancel]').click();
    await sleep(30);
    assert.equal((await store.listReviews()).length, 3);
  });

  test('корзина в списке удаляет ревью, не открывая его', async () => {
    const page = await seed();
    page.$(`#review-list li[data-id="${page.gamma.id}"] [data-act=delete]`).click();
    await sleep(30);
    assert.match(page.$('#danger .danger-q').textContent, /«Гамма»/);
    assert.match(page.$('#danger .danger-alert li').textContent, /^1 вариант /);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.deepEqual(titles(page.$$), ['Бета', 'Альфа']);
    assert.equal(page.$('.title-input').value, 'Бета');
  });

  test('если папку на диске удалить не удалось — ревью удалено, пользователь предупреждён', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    const sub = await folder.writeReview(page.root, await store.getReview(page.alpha.id));
    page.root.removeEntry = async () => {
      throw Object.assign(new Error('Файл занят'), { name: 'NoModificationAllowedError' });
    };
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.equal(await store.getReview(page.alpha.id), null);
    assert.match(page.$('#danger .danger-q').textContent, /папка на диске осталась/);
    assert.match(page.$('#danger .danger-note').textContent, new RegExp(`«${sub}».*Файл занят`));
  });

  test('«Скачать отчёт» в диалоге открывает экспорт HTML', async () => {
    const page = await seed();
    await openReview(page, page.alpha);
    page.$('[data-act=delete-review]').click();
    await sleep(30);
    page.$('#danger [data-act=extra]').click();
    assert.equal(page.chrome.tabs.create.mock.calls.at(-1).arguments[0].url, page.chrome.runtime.getURL(`pages/report.html?id=${page.alpha.id}&action=html`));
  });
});

describe('сверка с папкой при открытии', () => {
  // Все ревью сохранены в папку, затем папку очистили вручную.
  async function cleared() {
    const ctx = {};
    const page = await loadPage('pages/review', {
      setup: async () => {
        ctx.root = await connectFolder(MemDir);
        ctx.alpha = await store.createReview({ title: 'Альфа' });
        await sleep(3);
        ctx.beta = await store.createReview({ title: 'Бета' });
        await folder.flushUnsaved();
        ctx.root.children.clear();
      },
    });
    return { ...page, ...ctx };
  }

  test('папку очистили — окно со списком пропавших ревью', async () => {
    const page = await cleared();
    assert.equal(page.$('#danger').open, true);
    assert.equal(page.$('.danger-q').textContent, 'Папка «uniform-reviews-results» пуста');
    assert.deepEqual(page.$$('.danger-alert li').map((li) => li.textContent).sort(), ['Альфа — 0 групп · 0 вариантов', 'Бета — 0 групп · 0 вариантов']);
  });

  test('«Удалить из расширения» — ревью удаляются, страница показывает пустое состояние', async () => {
    const page = await cleared();
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.deepEqual(await store.listReviews(), []);
    assert.match(page.$('#main .empty').textContent, /Ревью не выбрано/);
    assert.match(page.$('#review-list').textContent, /Ревью пока нет/);
  });

  test('«Сохранить заново» — ревью снова в папке', async () => {
    const page = await cleared();
    page.$('#danger [data-act=extra]').click();
    await sleep(80);
    assert.equal(page.root.list().length, 2);
    assert.equal((await store.listReviews()).length, 2);
  });

  test('«Решить позже» — ничего не меняется', async () => {
    const page = await cleared();
    page.$('#danger button[value=cancel]').click();
    await sleep(40);
    assert.equal((await store.listReviews()).length, 2);
    assert.deepEqual(page.root.list(), []);
  });

  test('папка на месте — окно не появляется', async () => {
    const page = await seed();
    assert.equal(page.$('#danger').open, false);
  });
});

describe('папка для результатов', () => {
  test('не подключена — предупреждение и кнопка выбора; выбор сохраняет все ревью', async () => {
    const page = await seed({ withFolder: false });
    const box = page.$('#folder');
    assert.ok(box.classList.contains('attention'));
    assert.match(box.textContent, /Не подключена/);
    const ext = new MemDir('Uniform design checker');
    globalThis.showDirectoryPicker = async () => ext;
    try {
      box.querySelector('[data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(ext.list('uniform-reviews-results').length, 3);
    assert.match(page.$('#folder .folder-name').textContent, /Uniform design checker\/uniform-reviews-results\//);
    assert.match(page.$('#folder').textContent, /Сохраняется автоматически/);
  });

  test('выбор папки подтягивает сохранённые в ней ревью и показывает итог', async () => {
    const page = await seed({ withFolder: false });
    const saved = new MemDir('uniform-reviews-results');
    await folder.writeReview(saved, { id: 'disk-1', title: 'С диска', createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 1), issues: [] });
    saved.put('Битое/review.json', '{');
    globalThis.showDirectoryPicker = async () => saved;
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(200);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.ok(titles(page.$$).includes('С диска'));
    assert.match(page.$('#folder .folder-state.warn').textContent, /Восстановлено ревью из папки: 1\. Не удалось прочитать review\.json в папках: Битое\./);
  });

  test('в выбранной папке нет сохранённых ревью — подсказка указать другую', async () => {
    const page = await seed({ withFolder: false });
    globalThis.showDirectoryPicker = async () => new MemDir('uniform-reviews-results');
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(150);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.match(page.$('#folder').textContent, /нет сохранённых ревью.*«Сменить»/);
  });

  test('отмена системного диалога выбора — без сообщений', async () => {
    const page = await seed({ withFolder: false });
    globalThis.showDirectoryPicker = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    try {
      page.$('#folder [data-act=pick]').click();
      await sleep(30);
    } finally {
      delete globalThis.showDirectoryPicker;
    }
    assert.equal(page.$('#danger').open, false);
  });

  test('нет разрешения — «Разрешить доступ» запрашивает его и сохраняет ревью', async () => {
    const page = await seed({ permission: 'prompt' });
    assert.match(page.$('#folder').textContent, /Нет доступа к папке\. Кликните в любом месте страницы/);
    page.$('#folder [data-act=grant]').click();
    await sleep(100);
    assert.equal(page.root.permission, 'granted');
    assert.equal(page.root.list().length, 3);
  });

  test('нет разрешения — первый клик в любом месте страницы молча возвращает доступ и дописывает несохранённое', async () => {
    const page = await seed({ permission: 'prompt' });
    await sleep(30);
    assert.deepEqual(page.root.list(), [], 'до клика ничего не пишется и не запрашивается');
    assert.equal(page.root.permission, 'prompt');
    page.$('#main').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(120);
    assert.equal(page.root.permission, 'granted');
    assert.equal(page.root.list().length, 3);
    assert.deepEqual(await folder.unsavedReviews(), []);
    assert.match(page.$('#folder').textContent, /Сохраняется автоматически/);
  });

  test('браузер не дал доступ по клику — блок папки показывает его ответ', async () => {
    const page = await seed({ permission: 'prompt' });
    page.root.grantOnRequest = false;
    await sleep(30);
    page.$('#main').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    assert.match(page.$('#folder .folder-state.err').textContent, /Браузер не дал доступ по клику \(ответ: prompt\)/);
  });

  test('клик по блоку папки не запускает фоновый запрос доступа (там свои кнопки)', async () => {
    const page = await seed({ permission: 'prompt' });
    await sleep(30);
    page.$('#folder').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    assert.equal(page.root.permission, 'prompt');
  });

  test('с доступом блок папки просит не закрывать страницу', async () => {
    const page = await seed();
    assert.match(page.$('#folder').textContent, /Не закрывайте эту страницу: пока она открыта, ревью сохраняются в папку/);
  });

  test('«Сохранить сейчас» пишет все ревью', async () => {
    const page = await seed();
    page.$('#folder [data-act=save]').click();
    await sleep(100);
    assert.equal(page.root.list().length, 3);
  });

  test('«Отключить» после подтверждения отвязывает папку, файлы остаются', async () => {
    const page = await seed();
    page.root.put('keep.txt', 'x');
    page.$('#folder [data-act=disconnect]').click();
    await sleep(20);
    assert.match(page.$('#danger .danger-q').textContent, /Отключить папку «uniform-reviews-results»\?/);
    page.$('#danger button[value=ok]').click();
    await sleep(60);
    assert.equal(await folder.getDir(), undefined);
    assert.ok(page.root.has('keep.txt'));
    assert.match(page.$('#folder').textContent, /Не подключена/);
  });

  test('ошибка записи показывается в блоке папки', async () => {
    const page = await seed();
    await folder.setStatus({ state: 'error', error: 'Нет места' });
    await sleep(40);
    assert.match(page.$('#folder .folder-state.err').textContent, /Ошибка записи: Нет места/);
  });
});

describe('описание группы (Markdown)', () => {
  async function alphaPage() {
    const page = await seed();
    await openReview(page, page.alpha);
    return page;
  }
  const ed = (page, group) => page.$(`[data-group="${group.id}"] [data-md]`);
  async function pageWithDescription(description) {
    let group;
    const page = await loadPage('pages/review', {
      setup: async () => {
        const rid = (await store.createReview({ title: 'R' })).id;
        ({ group } = await store.addIssue(rid, makeIssue()));
        await store.updateGroup(rid, group.id, { description });
      },
    });
    return { page, group };
  }

  test('описание показывается отформатированным; исходный Markdown — в режиме разметки', async () => {
    const { page, group: issue } = await pageWithDescription('**Важно**\n\n- отступ 16px\n- [x] цвет');
    const e = ed(page, issue);
    assert.equal(e.dataset.mode, 'visual');
    assert.equal(e.querySelector('.md-visual strong').textContent, 'Важно');
    assert.equal(e.querySelectorAll('.md-visual li').length, 2);
    assert.equal(e.querySelector('.md-visual li.todo').dataset.checked, 'true');
    assert.equal(e.querySelector('.md-source').value, '**Важно**\n\n- отступ 16px\n- [x] цвет');
    assert.equal(e.querySelector('.md-source').hidden, true);
  });

  test('переключение «Markdown» — для всех групп и запоминается', async () => {
    const page = await alphaPage();
    ed(page, page.g1).querySelector('[data-cmd=mode]').click();
    for (const issue of [page.g1, page.g2]) {
      assert.equal(ed(page, issue).dataset.mode, 'source');
      assert.equal(ed(page, issue).querySelector('.md-source').hidden, false);
      assert.equal(ed(page, issue).querySelector('.md-visual').hidden, true);
    }
    assert.equal(page.window.localStorage.getItem('udc-md-mode'), 'source');
    ed(page, page.g1).querySelector('[data-cmd=mode]').click();
    assert.equal(ed(page, page.g2).dataset.mode, 'visual');
  });

  test('правка в визуальном режиме сохраняется как Markdown', async () => {
    const page = await alphaPage();
    const visual = ed(page, page.g1).querySelector('.md-visual');
    visual.innerHTML = '<p>Нужен <b>отступ</b> 16px</p><ul><li>слева</li><li>справа</li></ul>';
    visual.dispatchEvent(new page.window.InputEvent('input', { bubbles: true }));
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).groups[0].description, 'Нужен **отступ** 16px\n\n- слева\n- справа');
    assert.equal(ed(page, page.g1).querySelector('.md-source').value, 'Нужен **отступ** 16px\n\n- слева\n- справа');
  });

  test('кнопки панели в режиме Markdown оборачивают выделение разметкой', async () => {
    const page = await alphaPage();
    const e = ed(page, page.g1);
    e.querySelector('[data-cmd=mode]').click();
    const ta = e.querySelector('.md-source');
    page.input(ta, 'сделать жирным');
    ta.setSelectionRange(8, 14);
    e.querySelector('[data-cmd=bold]').click();
    assert.equal(ta.value, 'сделать **жирным**');
    ta.setSelectionRange(0, 0);
    e.querySelector('[data-cmd=ul]').click();
    assert.equal(ta.value, '- сделать **жирным**');
    await sleep(500);
    assert.equal((await store.getReview(page.alpha.id)).groups[0].description, '- сделать **жирным**');
  });

  // Режим встраивания редактора туда, где localStorage чужой, а клавиатуру перехватывают раньше редактора.
  test('rememberMode: false — режим не читается и не пишется в localStorage', async () => {
    const page = await alphaPage();
    page.window.localStorage.setItem('udc-md-mode', 'source');
    const box = page.document.createElement('div');
    box.innerHTML = editorHtml({ placeholder: 'x' });
    page.document.body.append(box);
    const root = box.firstElementChild;
    mountEditor(root, { value: 'a', rememberMode: false });
    assert.equal(root.dataset.mode, 'visual');
    root.querySelector('[data-cmd=mode]').click();
    assert.equal(root.dataset.mode, 'source');
    page.window.localStorage.removeItem('udc-md-mode');
    root.querySelector('[data-cmd=mode]').click();
    assert.equal(page.window.localStorage.getItem('udc-md-mode'), null);
  });

  test('handleKeydown: нажатие, перехваченное до редактора, обрабатывается только в визуальном поле', async () => {
    const page = await alphaPage();
    const box = page.document.createElement('div');
    box.innerHTML = editorHtml({ placeholder: 'x' });
    page.document.body.append(box);
    const asked = [];
    const editor = mountEditor(box.firstElementChild, { value: 'текст', rememberMode: false, askLink: async (url) => (asked.push(url), null) });
    // Как контент-скрипт: перехват на window в фазе захвата, дальше событие не идёт.
    const intercept = (e) => {
      e.stopImmediatePropagation();
      editor.handleKeydown(e);
    };
    page.window.addEventListener('keydown', intercept, true);
    const press = (el) => el.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    try {
      const visual = box.querySelector('.md-visual');
      visual.focus();
      assert.equal(press(visual), false, '⌘/Ctrl+K в визуальном поле обработан');
      await sleep(5);
      assert.deepEqual(asked, ['']);
      assert.equal(press(box.querySelector('.md-source')), true, 'в режиме разметки — не трогаем');
      await sleep(5);
      assert.equal(asked.length, 1);
    } finally {
      page.window.removeEventListener('keydown', intercept, true);
    }
  });

  test('HTML в описании не исполняется', async () => {
    const { page, group } = await pageWithDescription('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    const visual = ed(page, group).querySelector('.md-visual');
    assert.equal(visual.querySelectorAll('img, a').length, 0);
    assert.match(visual.textContent, /<img src=x onerror=alert\(1\)>/);
  });

});

describe('фоновый скрипт на старом коде', () => {
  async function pageWith(t, reply) {
    t.mock.method(globalThis, 'fetch', async () => new Response('код'));
    return loadPage('pages/review', {
      setup: async (env) => {
        await store.createReview({ title: 'R' });
        env.chrome.runtime.sendMessage = t.mock.fn(async () => reply);
        env.chrome.runtime.reload = t.mock.fn();
      },
    });
  }

  test('старый фоновый скрипт (не знает udc:codeVersion) → предупреждение с перезагрузкой', async (t) => {
    const page = await pageWith(t, { ok: false, error: 'Неизвестное сообщение: udc:codeVersion' });
    await sleep(30);
    const bar = page.$('.stale-bg');
    assert.ok(bar, 'есть предупреждение');
    assert.match(bar.textContent, /не перезагружено/);
    await page.chrome.storage.local.set({ folderSynced: { x: { at: 1, v: 2 } } });
    bar.querySelector('[data-act=reload-ext]').click();
    await sleep(20);
    assert.equal(page.chrome.runtime.reload.mock.callCount(), 1);
    assert.equal(page.chrome.storage.local.data.get('reopenAfterReload'), page.window.location.href);
    assert.equal(page.chrome.storage.local.data.has('folderSynced'), false, 'всё перезапишется новым кодом');
  });

  test('другой отпечаток кода → предупреждение; тот же → нет', async (t) => {
    let page = await pageWith(t, { ok: true, fingerprint: '0000000000000000' });
    await sleep(30);
    assert.ok(page.$('.stale-bg'));
    const { codeFingerprint } = await import('../../lib/code-version.js');
    const same = await codeFingerprint();
    page = await pageWith(t, { ok: true, fingerprint: same });
    await sleep(30);
    assert.equal(page.$('.stale-bg'), null);
  });
});
