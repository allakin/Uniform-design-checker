import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv, makeIssue } from '../helpers/env.js';
import * as store from '../../lib/store.js';

let chrome;
const raw = (key) => chrome.storage.local.data.get(key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  ({ chrome } = installEnv());
});

describe('createReview', () => {
  test('создаёт ревью, кладёт его в индекс и делает текущим', async () => {
    const r = await store.createReview({ title: '  Оплата  ', author: ' Анна ', devTicketUrl: 'https://t/DEV-1', designTicketUrl: '' });
    assert.equal(r.title, 'Оплата');
    assert.equal(r.author, 'Анна');
    assert.equal(r.devTicketUrl, 'https://t/DEV-1');
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.groups, []);
    assert.ok(r.id);
    assert.equal(typeof r.createdAt, 'number');
    assert.deepEqual(raw(`review:${r.id}`).title, 'Оплата');
    assert.equal(raw('activeReviewId'), r.id);
    const [meta] = raw('reviewIndex');
    assert.equal(meta.id, r.id);
    assert.equal(meta.issueCount, 0);
    assert.equal(meta.groupCount, 0);
    assert.equal(meta.author, 'Анна');
  });

  test('пустое название заменяется на «Дизайн-ревью»', async () => {
    const r = await store.createReview({ title: '   ' });
    assert.equal(r.title, 'Дизайн-ревью');
    assert.equal(r.author, '');
    assert.equal(r.devTicketUrl, '');
    assert.equal(r.designTicketUrl, '');
  });

  test('id уникальны', async () => {
    const ids = new Set();
    for (let i = 0; i < 20; i++) ids.add((await store.createReview({ title: `R${i}` })).id);
    assert.equal(ids.size, 20);
  });
});

describe('чтение', () => {
  test('getReview: null для пустого и неизвестного id', async () => {
    assert.equal(await store.getReview(), null);
    assert.equal(await store.getReview(''), null);
    assert.equal(await store.getReview('nope'), null);
  });

  test('listReviews сортирует по дате изменения, свежие сверху', async () => {
    const a = await store.createReview({ title: 'A' });
    await sleep(3);
    const b = await store.createReview({ title: 'B' });
    await sleep(3);
    await store.updateReview(a.id, { author: 'X' });
    assert.deepEqual((await store.listReviews()).map((m) => m.title), ['A', 'B']);
    assert.ok(b);
  });

  test('listReviews не мутирует сохранённый индекс', async () => {
    await store.createReview({ title: 'A' });
    const list = await store.listReviews();
    list.push({ id: 'fake' });
    assert.equal((await store.listReviews()).length, 1);
  });

  test('getAllReviews возвращает полные объекты и пропускает «битые» записи индекса', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    chrome.storage.local.data.delete(`review:${a.id}`);
    const all = await store.getAllReviews();
    assert.deepEqual(all.map((r) => r.title), ['B']);
    assert.ok(Array.isArray(all[0].issues));
  });

  test('пустое хранилище', async () => {
    assert.deepEqual(await store.listReviews(), []);
    assert.deepEqual(await store.getAllReviews(), []);
    assert.equal(await store.getActiveReviewId(), null);
    assert.equal(await store.getActiveReview(), null);
  });
});

describe('importReview', () => {
  test('сохраняет ревью как есть, с исходной датой изменения; новое ревью не становится текущим', async () => {
    const review = { id: 'r-old', title: 'С диска', author: '', devTicketUrl: '', designTicketUrl: '', createdAt: 1000, updatedAt: 2000, issues: [makeIssue()] };
    assert.equal(await store.importReview(review), true);
    assert.equal((await store.getReview('r-old')).updatedAt, 2000);
    const [meta] = await store.listReviews();
    assert.deepEqual([meta.id, meta.updatedAt, meta.issueCount], ['r-old', 2000, 1]);
    assert.equal(await store.getActiveReviewId(), null);
  });

  test('существующее ревью не перезаписывается', async () => {
    const live = await store.createReview({ title: 'Живое' });
    assert.equal(await store.importReview({ ...live, title: 'С диска', issues: [] }), false);
    assert.equal((await store.getReview(live.id)).title, 'Живое');
    assert.equal((await store.listReviews()).length, 1);
  });
});

describe('activeOrLatestReview', () => {
  test('есть текущее — возвращает его', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    await store.setActiveReviewId(a.id);
    assert.equal((await store.activeOrLatestReview()).id, a.id);
  });
  test('текущего нет — делает текущим последнее изменённое', async () => {
    await store.importReview({ id: 'old', title: 'Старое', createdAt: 1, updatedAt: 10, issues: [] });
    await store.importReview({ id: 'new', title: 'Свежее', createdAt: 2, updatedAt: 20, issues: [] });
    assert.equal((await store.activeOrLatestReview()).id, 'new');
    assert.equal(await store.getActiveReviewId(), 'new');
  });
  test('текущее удалено — берёт последнее из оставшихся', async () => {
    const a = await store.createReview({ title: 'A' });
    const b = await store.createReview({ title: 'B' });
    await store.deleteReview(b.id);
    assert.equal((await store.activeOrLatestReview()).id, a.id);
  });
  test('ревью нет — null', async () => {
    assert.equal(await store.activeOrLatestReview(), null);
  });
});

describe('updateReview', () => {
  test('меняет поля, обновляет updatedAt и индекс', async () => {
    const r = await store.createReview({ title: 'A' });
    await sleep(2);
    const u = await store.updateReview(r.id, { title: 'B', designTicketUrl: 'https://d/1' });
    assert.equal(u.title, 'B');
    assert.ok(u.updatedAt > r.updatedAt);
    assert.equal(u.createdAt, r.createdAt);
    assert.equal(raw('reviewIndex')[0].title, 'B');
    assert.equal(raw('reviewIndex').length, 1);
  });

  test('бросает ошибку для несуществующего ревью', async () => {
    await assert.rejects(store.updateReview('nope', { title: 'x' }), /Ревью не найдено/);
  });
});

describe('deleteReview', () => {
  test('удаляет ревью и запись в индексе', async () => {
    const a = await store.createReview({ title: 'A' });
    const b = await store.createReview({ title: 'B' });
    await store.deleteReview(a.id);
    assert.equal(raw(`review:${a.id}`), undefined);
    assert.deepEqual(raw('reviewIndex').map((m) => m.id), [b.id]);
  });

  test('сбрасывает текущее ревью, если удалили его', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.deleteReview(a.id);
    assert.equal(await store.getActiveReviewId(), null);
  });

  test('не трогает текущее ревью, если удалили другое', async () => {
    const a = await store.createReview({ title: 'A' });
    const b = await store.createReview({ title: 'B' });
    await store.deleteReview(a.id);
    assert.equal(await store.getActiveReviewId(), b.id);
  });

  test('удаление несуществующего — без ошибок', async () => {
    await store.deleteReview('nope');
  });
});

describe('текущее ревью', () => {
  test('setActiveReviewId / getActiveReview', async () => {
    const a = await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    await store.setActiveReviewId(a.id);
    assert.equal((await store.getActiveReview()).title, 'A');
  });

  test('setActiveReviewId(null) снимает текущее', async () => {
    await store.createReview({ title: 'A' });
    await store.setActiveReviewId(null);
    assert.equal(raw('activeReviewId'), undefined);
    assert.equal(await store.getActiveReview(), null);
  });

  test('getActiveReview: null, если текущее ревью удалили из хранилища в обход API', async () => {
    const a = await store.createReview({ title: 'A' });
    chrome.storage.local.data.delete(`review:${a.id}`);
    assert.equal(await store.getActiveReview(), null);
  });
});

const groupTitles = async (id) => (await store.getReview(id)).groups.map((g) => g.title);
const variantGroups = async (id) => {
  const r = await store.getReview(id);
  return r.issues.map((i) => r.groups.find((g) => g.id === i.groupId)?.title);
};

describe('варианты блоков', () => {
  test('addIssue с названием новой группы создаёт группу и кладёт в неё вариант', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue, group, number } = await store.addIssue(r.id, { newGroupTitle: '  Кнопка удаления ', note: 'красная' });
    assert.equal(number, 1);
    assert.equal(group.title, 'Кнопка удаления');
    assert.equal(issue.groupId, group.id);
    assert.equal(issue.note, 'красная');
    assert.ok(issue.id);
    assert.equal(typeof issue.createdAt, 'number');
    assert.equal(issue.newGroupTitle, undefined, 'служебное поле не сохраняется');
    const meta = raw('reviewIndex')[0];
    assert.equal(meta.issueCount, 1);
    assert.equal(meta.groupCount, 1);
  });

  test('addIssue в существующую группу: номер — порядковый внутри группы', async () => {
    const r = await store.createReview({ title: 'A' });
    const { group } = await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    await store.addIssue(r.id, { newGroupTitle: 'Модалка' });
    const { number, group: same } = await store.addIssue(r.id, { groupId: group.id });
    assert.equal(number, 2);
    assert.equal(same.id, group.id);
    assert.deepEqual(await variantGroups(r.id), ['Кнопка', 'Модалка', 'Кнопка']);
  });

  test('addIssue: новая группа с уже существующим названием не дублируется', async () => {
    const r = await store.createReview({ title: 'A' });
    await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    const { number } = await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    assert.equal(number, 2);
    assert.deepEqual(await groupTitles(r.id), ['Кнопка']);
  });

  test('addIssue: группу удалили, пока была открыта форма, — понятная ошибка; без группы — тоже', async () => {
    const r = await store.createReview({ title: 'A' });
    await assert.rejects(store.addIssue(r.id, { groupId: 'gone' }), /Группа не найдена/);
    await assert.rejects(store.addIssue(r.id, { newGroupTitle: '   ' }), /Укажите группу/);
    assert.equal((await store.getReview(r.id)).issues.length, 0);
  });

  test('addIssue: удалённую группу заменяет название новой, если оно передано', async () => {
    const r = await store.createReview({ title: 'A' });
    const { group } = await store.addIssue(r.id, { groupId: 'gone', newGroupTitle: 'Кнопка' });
    assert.equal(group.title, 'Кнопка');
  });

  test('addIssue в несуществующее ревью — понятная ошибка', async () => {
    await assert.rejects(store.addIssue('nope', { newGroupTitle: 'x' }), /Ревью не найдено — создайте новое/);
  });

  test('addIssue: переданные id/createdAt имеют приоритет (импорт)', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue } = await store.addIssue(r.id, { id: 'fixed', createdAt: 5, newGroupTitle: 'x' });
    assert.equal(issue.id, 'fixed');
    assert.equal(issue.createdAt, 5);
  });

  test('addIssue в ревью без поля groups (старые данные) — группы появляются', async () => {
    const r = await store.createReview({ title: 'A' });
    const stored = raw(`review:${r.id}`);
    delete stored.groups;
    chrome.storage.local.data.set(`review:${r.id}`, stored);
    await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    assert.deepEqual(await groupTitles(r.id), ['Кнопка']);
  });

  test('updateIssue меняет поля и ставит updatedAt', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue } = await store.addIssue(r.id, { newGroupTitle: 'x' });
    const u = await store.updateIssue(r.id, issue.id, { note: 'другой радиус' });
    assert.equal(u.note, 'другой радиус');
    assert.equal(typeof u.updatedAt, 'number');
    assert.equal((await store.getReview(r.id)).issues[0].note, 'другой радиус');
  });

  test('updateIssue: ошибка для неизвестного варианта или ревью', async () => {
    const r = await store.createReview({ title: 'A' });
    await assert.rejects(store.updateIssue(r.id, 'nope', {}), /Вариант не найден/);
    await assert.rejects(store.updateIssue('nope', 'nope', {}), /Вариант не найден/);
  });

  test('deleteIssue удаляет только указанный вариант, группа остаётся', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue: a } = await store.addIssue(r.id, { newGroupTitle: 'a', note: 'первый' });
    await store.addIssue(r.id, { newGroupTitle: 'a', note: 'второй' });
    await store.deleteIssue(r.id, a.id);
    const after = await store.getReview(r.id);
    assert.deepEqual(after.issues.map((i) => i.note), ['второй']);
    assert.deepEqual(after.groups.map((g) => g.title), ['a']);
    assert.equal(raw('reviewIndex')[0].issueCount, 1);
  });

  test('deleteIssue в несуществующем ревью — без ошибок', async () => {
    await store.deleteIssue('nope', 'nope');
  });

  test('moveIssueToGroup переносит вариант в конец другой группы', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue: a, group: g1 } = await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    const { group: g2 } = await store.addIssue(r.id, { newGroupTitle: 'Модалка' });
    await store.addIssue(r.id, { groupId: g1.id });
    const moved = await store.moveIssueToGroup(r.id, a.id, { groupId: g2.id });
    assert.equal(moved.id, g2.id);
    assert.deepEqual(await variantGroups(r.id), ['Модалка', 'Кнопка', 'Модалка']);
    assert.equal((await store.getReview(r.id)).issues.at(-1).id, a.id);
  });

  test('moveIssueToGroup в новую группу создаёт её; ошибки — для неизвестных варианта и группы', async () => {
    const r = await store.createReview({ title: 'A' });
    const { issue } = await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    await store.moveIssueToGroup(r.id, issue.id, { newGroupTitle: 'Кнопка удаления' });
    assert.deepEqual(await variantGroups(r.id), ['Кнопка удаления']);
    await assert.rejects(store.moveIssueToGroup(r.id, issue.id, { groupId: 'nope' }), /Группа не найдена/);
    await assert.rejects(store.moveIssueToGroup(r.id, 'nope', { newGroupTitle: 'x' }), /Вариант не найден/);
  });
});

describe('migrateIfNeeded', () => {
  test('ревью прежнего формата в хранилище переводятся в группы без смены даты; повторно ничего не пишется', async () => {
    const r = await store.createReview({ title: 'Старое' });
    const stored = raw(`review:${r.id}`);
    delete stored.groups;
    stored.updatedAt = 7;
    stored.issues = [{ id: 'a', title: 'Кнопка', severity: 'high' }, { id: 'b', title: 'Кнопка' }];
    chrome.storage.local.data.set(`review:${r.id}`, stored);
    await store.migrateIfNeeded();
    const after = await store.getReview(r.id);
    assert.deepEqual(after.groups.map((g) => g.title), ['Кнопка']);
    assert.ok(after.issues.every((i) => i.groupId === after.groups[0].id && i.title === undefined));
    assert.equal(after.updatedAt, 7);
    assert.equal(raw('reviewIndex')[0].groupCount, 1);
    let writes = 0;
    chrome.storage.onChanged.addListener(() => writes++);
    await store.migrateIfNeeded();
    assert.equal(writes, 0);
  });
});

describe('группы блоков', () => {
  test('addGroup создаёт пустую группу; пустое название — «Новая группа»', async () => {
    const r = await store.createReview({ title: 'A' });
    const g = await store.addGroup(r.id, ' Модалка ');
    assert.equal(g.title, 'Модалка');
    assert.equal(g.description, '');
    assert.equal(g.mockupUrl, '');
    await store.addGroup(r.id, '');
    assert.deepEqual(await groupTitles(r.id), ['Модалка', 'Новая группа']);
    assert.equal(raw('reviewIndex')[0].groupCount, 2);
    await assert.rejects(store.addGroup('nope', 'x'), /Ревью не найдено/);
  });

  test('updateGroup меняет название, описание и макет', async () => {
    const r = await store.createReview({ title: 'A' });
    const g = await store.addGroup(r.id, 'Кнопка');
    const u = await store.updateGroup(r.id, g.id, { title: 'Кнопка удаления', description: 'Красная, 32px', mockupUrl: 'https://figma.com/x' });
    assert.equal(u.title, 'Кнопка удаления');
    assert.equal(typeof u.updatedAt, 'number');
    assert.equal((await store.getReview(r.id)).groups[0].description, 'Красная, 32px');
    await assert.rejects(store.updateGroup(r.id, 'nope', {}), /Группа не найдена/);
  });

  test('deleteGroup удаляет группу вместе с её вариантами', async () => {
    const r = await store.createReview({ title: 'A' });
    const { group } = await store.addIssue(r.id, { newGroupTitle: 'Кнопка' });
    await store.addIssue(r.id, { newGroupTitle: 'Модалка' });
    await store.addIssue(r.id, { groupId: group.id });
    await store.deleteGroup(r.id, group.id);
    assert.deepEqual(await groupTitles(r.id), ['Модалка']);
    assert.deepEqual(await variantGroups(r.id), ['Модалка']);
    assert.equal(raw('reviewIndex')[0].issueCount, 1);
    await store.deleteGroup('nope', 'nope'); // без ошибок
  });

  test('moveGroup двигает вверх и вниз', async () => {
    const r = await store.createReview({ title: 'A' });
    const ids = [];
    for (const t of ['a', 'b', 'c']) ids.push((await store.addGroup(r.id, t)).id);
    await store.moveGroup(r.id, ids[2], -1);
    assert.deepEqual(await groupTitles(r.id), ['a', 'c', 'b']);
    await store.moveGroup(r.id, ids[0], 1);
    assert.deepEqual(await groupTitles(r.id), ['c', 'a', 'b']);
  });

  test('moveGroup за границы списка ничего не меняет и не пишет', async () => {
    const r = await store.createReview({ title: 'A' });
    const a = await store.addGroup(r.id, 'a');
    const b = await store.addGroup(r.id, 'b');
    const before = (await store.getReview(r.id)).updatedAt;
    await sleep(2);
    await store.moveGroup(r.id, a.id, -1);
    await store.moveGroup(r.id, b.id, 1);
    await store.moveGroup(r.id, 'nope', 1);
    await store.moveGroup('nope', a.id, 1);
    const after = await store.getReview(r.id);
    assert.deepEqual(after.groups.map((g) => g.title), ['a', 'b']);
    assert.equal(after.updatedAt, before);
  });
});

describe('параллельные записи', () => {
  test('одновременные addIssue не теряют замечания', async () => {
    const r = await store.createReview({ title: 'A' });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.addIssue(r.id, { newGroupTitle: 'Кнопка', note: `#${i}` })));
    assert.deepEqual(results.map((x) => x.number).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal((await store.getReview(r.id)).issues.length, 25);
    assert.equal(raw('reviewIndex')[0].issueCount, 25);
  });

  test('одновременное создание ревью не теряет записи индекса', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.createReview({ title: `R${i}` })));
    assert.equal(raw('reviewIndex').length, 10);
  });

  test('ошибка в одной операции не ломает очередь', async () => {
    const r = await store.createReview({ title: 'A' });
    const bad = store.updateReview('nope', {});
    const good = store.addIssue(r.id, { newGroupTitle: 'ok' });
    await assert.rejects(bad);
    assert.equal((await good).number, 1);
  });
});

describe('поисковый текст в индексе', () => {
  test('включает название, ревьюера, тикеты, группы, заметки и страницы вариантов в нижнем регистре', async () => {
    const r = await store.createReview({ title: 'Оплата', author: 'Анна', devTicketUrl: 'https://t/DEV-7', designTicketUrl: 'https://t/DES-9' });
    await store.addIssue(r.id, makeIssue({ group: 'Кнопка КУПИТЬ', note: 'Другой РАДИУС', page: { url: 'https://shop.ru/cart', title: 'Корзина' } }));
    const { search } = raw('reviewIndex')[0];
    for (const part of ['оплата', 'анна', 'dev-7', 'des-9', 'кнопка купить', 'другой радиус', 'https://shop.ru/cart', 'корзина']) {
      assert.ok(search.includes(part), part);
    }
    assert.equal(search, search.toLowerCase());
  });

  test('не содержит скриншотов и ограничен 4000 символами', async () => {
    const r = await store.createReview({ title: 'A' });
    for (let i = 0; i < 40; i++) await store.addIssue(r.id, makeIssue({ note: 'x'.repeat(200) }));
    const { search } = raw('reviewIndex')[0];
    assert.ok(search.length <= 4000);
    assert.ok(!search.includes('data:image'));
  });

  test('reindexIfNeeded дополняет старые записи без поиска и не трогает дату', async () => {
    const r = await store.createReview({ title: 'Старое', author: 'Пётр' });
    const index = raw('reviewIndex');
    delete index[0].search;
    index[0].updatedAt = 1;
    chrome.storage.local.data.set('reviewIndex', index);
    await store.reindexIfNeeded();
    const [meta] = raw('reviewIndex');
    assert.ok(meta.search.includes('старое'));
    assert.equal(meta.id, r.id);
    // updatedAt берётся из самого ревью — не меняется на «сейчас»
    assert.equal(meta.updatedAt, (await store.getReview(r.id)).updatedAt);
  });

  test('reindexIfNeeded ничего не пишет, если всё проиндексировано', async () => {
    await store.createReview({ title: 'A' });
    let writes = 0;
    chrome.storage.onChanged.addListener(() => writes++);
    await store.reindexIfNeeded();
    assert.equal(writes, 0);
  });

  test('reindexIfNeeded пропускает записи индекса без ревью', async () => {
    chrome.storage.local.data.set('reviewIndex', [{ id: 'ghost', title: 'G', updatedAt: 1 }]);
    await store.reindexIfNeeded();
    assert.equal(raw('reviewIndex')[0].search, undefined);
  });
});

describe('onReviewsChanged', () => {
  test('вызывается на изменения ревью, индекса и текущего ревью', async () => {
    let calls = 0;
    const off = store.onReviewsChanged(() => calls++);
    await chrome.storage.local.set({ 'review:1': {} });
    await chrome.storage.local.set({ reviewIndex: [] });
    await chrome.storage.local.set({ activeReviewId: '1' });
    assert.equal(calls, 3);
    off();
    await chrome.storage.local.set({ reviewIndex: [] });
    assert.equal(calls, 3);
  });

  test('игнорирует посторонние ключи и другие области хранилища', async () => {
    let calls = 0;
    store.onReviewsChanged(() => calls++);
    await chrome.storage.local.set({ exportFormat: 'pdf', folderStatus: {} });
    chrome.storage.onChanged.dispatch({ reviewIndex: {} }, 'sync');
    assert.equal(calls, 0);
  });
});

test('uid генерирует UUID v4', () => {
  assert.match(store.uid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
