import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupsOf, groupTitleOf, pageKey, pagesCount, migrateLegacy, UNGROUPED_TITLE } from '../../lib/groups.js';
import { makeIssue, makeReview, makeGroup } from '../helpers/env.js';

describe('groupsOf', () => {
  test('варианты разложены по группам в порядке групп; пустая группа тоже показывается', () => {
    const a = makeIssue({ group: 'Кнопка' });
    const b = makeIssue({ group: 'Модалка' });
    const c = makeIssue({ group: 'Кнопка' });
    const review = makeReview({ issues: [a, b, c], groups: [makeGroup('Модалка'), makeGroup('Кнопка'), makeGroup('Пустая')] });
    const result = groupsOf(review);
    assert.deepEqual(result.map((e) => e.group.title), ['Модалка', 'Кнопка', 'Пустая']);
    assert.deepEqual(result.map((e) => e.variants.map((v) => v.id)), [[b.id], [a.id, c.id], []]);
  });

  test('варианты без своей группы — в конце, в группе «Без группы»', () => {
    const lost = makeIssue({ group: 'Удалённая' });
    const review = makeReview({ issues: [lost], groups: [makeGroup('Кнопка')] });
    const result = groupsOf(review);
    assert.deepEqual(result.map((e) => [e.group.id, e.group.title]), [['g-Кнопка', 'Кнопка'], ['', UNGROUPED_TITLE]]);
    assert.equal(result[1].variants[0].id, lost.id);
    assert.equal(groupTitleOf(review, lost), UNGROUPED_TITLE);
  });

  test('ревью без поля groups не ломается', () => {
    assert.deepEqual(groupsOf({ issues: [] }), []);
    assert.deepEqual(groupsOf(null), []);
  });
});

describe('страницы', () => {
  test('pageKey — хост и путь без протокола, параметров, якоря и завершающего слэша', () => {
    assert.equal(pageKey('https://shop.ru/cart/?utm=1#top'), 'shop.ru/cart');
    assert.equal(pageKey('https://shop.ru/'), 'shop.ru');
    assert.equal(pageKey('не ссылка'), 'не ссылка');
    assert.equal(pageKey(undefined), '');
  });

  test('pagesCount не считает одну страницу с разными параметрами дважды', () => {
    const v = (url) => makeIssue({ page: { url } });
    assert.equal(pagesCount([v('https://a.ru/x?tab=1'), v('https://a.ru/x?tab=2'), v('https://a.ru/y')]), 2);
    assert.equal(pagesCount([makeIssue({ page: undefined })]), 0);
  });
});

describe('migrateLegacy', () => {
  let n = 0;
  const uid = () => `new-${++n}`;

  test('замечания Design Review Checker с одинаковым названием становятся вариантами одной группы', () => {
    const legacy = {
      id: 'r',
      createdAt: 1,
      issues: [
        { id: 'a', title: 'Кнопка', description: 'Должна быть красной', mockupUrl: 'https://figma.com/a', severity: 'high', fixImages: [{ src: 'x' }], createdAt: 2 },
        { id: 'b', title: ' Модалка ', description: '', severity: 'low', createdAt: 3 },
        { id: 'c', title: 'Кнопка', description: 'другое описание', mockupUrl: 'https://figma.com/c', createdAt: 4 },
        { id: 'd', title: '', createdAt: 5 },
      ],
    };
    const r = migrateLegacy(legacy, uid);
    assert.deepEqual(r.groups.map((g) => g.title), ['Кнопка', 'Модалка', UNGROUPED_TITLE]);
    assert.equal(r.groups[0].description, 'Должна быть красной', 'описание — от первого замечания');
    assert.equal(r.groups[0].mockupUrl, 'https://figma.com/a');
    assert.deepEqual(r.issues.map((i) => r.groups.find((g) => g.id === i.groupId).title), ['Кнопка', 'Модалка', 'Кнопка', UNGROUPED_TITLE]);
    for (const i of r.issues) {
      for (const gone of ['title', 'description', 'mockupUrl', 'severity', 'fixImages']) assert.equal(i[gone], undefined, gone);
      assert.equal(i.note, '');
    }
  });

  test('ревью, где у всех вариантов есть группа, возвращается как есть', () => {
    const review = makeReview({ issues: [makeIssue()] });
    assert.equal(migrateLegacy(review, uid), review);
  });

  test('потерявшие группу варианты нового формата получают группу по прежнему названию или «Без группы»', () => {
    const review = makeReview({ issues: [makeIssue({ group: 'Кнопка' }), { ...makeIssue(), groupId: 'gone' }], groups: [makeGroup('Кнопка')] });
    const r = migrateLegacy(review, uid);
    assert.deepEqual(r.groups.map((g) => g.title), ['Кнопка', UNGROUPED_TITLE]);
    assert.equal(r.issues[0].groupId, 'g-Кнопка');
  });
});
