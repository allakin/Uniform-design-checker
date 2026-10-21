import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv, makeIssue, makeReview, PNG, PNG_2, JPEG } from '../helpers/env.js';
import { MemDir } from '../helpers/fs.js';
import * as folder from '../../lib/folder.js';
import * as store from '../../lib/store.js';

let chrome;
const status = () => chrome.storage.local.data.get(folder.KEY_FOLDER_STATUS);
const names = () => chrome.storage.local.data.get('folderNames') || {};

beforeEach(() => {
  ({ chrome } = installEnv());
});

async function connected(perm = 'granted') {
  const root = new MemDir('uniform-reviews-results', { permission: perm });
  await folder.setDir(root);
  return root;
}

describe('safeName', () => {
  test('заменяет запрещённые символы и управляющие коды на пробел', () => {
    assert.equal(folder.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    assert.equal(folder.safeName('a\u0000b\nc\td'), 'a b c d');
  });
  test('схлопывает пробелы и обрезает края', () => {
    assert.equal(folder.safeName('   много    пробелов  '), 'много пробелов');
  });
  test('убирает точки в начале (скрытые файлы)', () => {
    assert.equal(folder.safeName('...git'), 'git');
  });
  test('ограничивает длину', () => {
    assert.equal(folder.safeName('я'.repeat(100)).length, 60);
    assert.equal(folder.safeName('я'.repeat(100), 10).length, 10);
    assert.equal(folder.safeName('слово '.repeat(20), 12), 'слово слово');
  });
  test('пустое имя → «Без названия»', () => {
    for (const v of ['', '   ', '...', '///', null, undefined]) assert.equal(folder.safeName(v), 'Без названия', String(v));
  });
});

describe('folderLabel', () => {
  test('с проектом и без', () => {
    const dir = { name: 'uniform-reviews-results' };
    assert.equal(folder.folderLabel(dir, { project: 'my-ext' }), 'my-ext/uniform-reviews-results');
    assert.equal(folder.folderLabel(dir, {}), 'uniform-reviews-results');
    assert.equal(folder.folderLabel(dir), 'uniform-reviews-results');
  });
});

describe('хранение дескриптора папки (IndexedDB)', () => {
  test('setDir / getDir / clearDir', async () => {
    assert.equal(await folder.getDir(), undefined);
    const dir = new MemDir('uniform-reviews-results');
    await folder.setDir(dir);
    assert.equal(await folder.getDir(), dir);
    await folder.clearDir();
    assert.equal(await folder.getDir(), undefined);
  });
});

describe('connectResultsFolder', () => {
  test('выбрана сама папка uniform-reviews-results — используется как есть', async () => {
    const picked = new MemDir('uniform-reviews-results');
    const { dir, project } = await folder.connectResultsFolder(picked);
    assert.equal(dir, picked);
    assert.equal(project, '');
    assert.equal(await folder.getDir(), picked);
    assert.deepEqual(status(), { state: 'ok', dirName: 'uniform-reviews-results', project: '', error: '' });
  });

  test('выбрана папка расширения — берётся/создаётся uniform-reviews-results внутри', async () => {
    const picked = new MemDir('Uniform design checker');
    const { dir, project } = await folder.connectResultsFolder(picked);
    assert.equal(dir.name, 'uniform-reviews-results');
    assert.equal(picked.at('uniform-reviews-results'), dir);
    assert.equal(project, 'Uniform design checker');
    assert.equal(status().project, 'Uniform design checker');
  });

  test('существующая uniform-reviews-results внутри не пересоздаётся', async () => {
    const picked = new MemDir('ext');
    picked.put('uniform-reviews-results/.gitkeep', '');
    const { dir } = await folder.connectResultsFolder(picked);
    assert.deepEqual(dir.list(), ['.gitkeep']);
  });

  test('папка с другим именем, где уже лежат ревью, используется как есть', async () => {
    const picked = new MemDir('Мои ревью');
    await folder.writeReview(picked, makeReview({ title: 'Старое' }));
    const { dir, project } = await folder.connectResultsFolder(picked);
    assert.equal(dir, picked);
    assert.equal(project, '');
    assert.equal(picked.has('uniform-reviews-results'), false);
    assert.equal(status().dirName, 'Мои ревью');
  });

  test('только чтение: в папке расширения без uniform-reviews-results ничего не создаётся', async () => {
    const picked = new MemDir('ext');
    const { dir, project } = await folder.connectResultsFolder(picked, { readOnly: true });
    assert.equal(dir, picked);
    assert.equal(project, '');
    assert.deepEqual(picked.list(), []);
  });

  test('только чтение: существующая uniform-reviews-results внутри подхватывается', async () => {
    const picked = new MemDir('ext');
    picked.put('uniform-reviews-results/.gitkeep', '');
    const { dir, project } = await folder.connectResultsFolder(picked, { readOnly: true });
    assert.equal(dir, picked.at('uniform-reviews-results'));
    assert.equal(project, 'ext');
  });

  test('pickResultsFolder({ readOnly }) просит у браузера только чтение', async () => {
    let opts;
    globalThis.showDirectoryPicker = async (o) => ((opts = o), new MemDir('uniform-reviews-results'));
    try {
      await folder.pickResultsFolder({ readOnly: true });
      assert.deepEqual(opts, { id: 'udc-results', mode: 'read' });
    } finally {
      delete globalThis.showDirectoryPicker;
    }
  });

  test('pickResultsFolder открывает системный диалог с режимом записи', async () => {
    let opts;
    globalThis.showDirectoryPicker = async (o) => ((opts = o), new MemDir('uniform-reviews-results'));
    try {
      const { dir } = await folder.pickResultsFolder();
      assert.equal(dir.name, 'uniform-reviews-results');
      assert.deepEqual(opts, { id: 'udc-results', mode: 'readwrite' });
    } finally {
      delete globalThis.showDirectoryPicker;
    }
  });
});

describe('permission', () => {
  test('без request только проверяет', async () => {
    const dir = new MemDir('d', { permission: 'prompt' });
    assert.equal(await folder.permission(dir), 'prompt');
    assert.equal(dir.permission, 'prompt');
  });
  test('с request запрашивает при состоянии prompt', async () => {
    const dir = new MemDir('d', { permission: 'prompt' });
    assert.equal(await folder.permission(dir, true), 'granted');
  });
  test('denied не перезапрашивается', async () => {
    const dir = new MemDir('d', { permission: 'denied' });
    assert.equal(await folder.permission(dir, true), 'denied');
  });
});

describe('requestAccess', () => {
  test('разрешили — дописывает все ревью из хранилища', async () => {
    const root = await connected('prompt');
    await store.createReview({ title: 'Копилось без доступа' });
    assert.equal(await folder.requestAccess(root), 'granted');
    assert.match(root.list()[0], /^Копилось без доступа — /);
    assert.equal(status().state, 'ok');
  });
  test('отказали — ничего не пишет', async () => {
    const root = new MemDir('uniform-reviews-results', { permission: 'prompt', grantOnRequest: false });
    await store.createReview({ title: 'X' });
    assert.equal(await folder.requestAccess(root), 'prompt');
    assert.deepEqual(root.list(), []);
  });
  test('ошибка записи после разрешения — статус error, исключения нет', async () => {
    const root = await connected('prompt');
    root.failWrites = 'Только чтение';
    await store.addIssue((await store.createReview({ title: 'X' })).id, makeIssue());
    assert.equal(await folder.requestAccess(root), 'granted');
    assert.equal(status().state, 'error');
  });
});

describe('setStatus', () => {
  test('сливает с предыдущим состоянием', async () => {
    await folder.setStatus({ state: 'ok', dirName: 'x', project: 'p' });
    await folder.setStatus({ state: 'error', error: 'boom' });
    assert.deepEqual(status(), { state: 'error', dirName: 'x', project: 'p', error: 'boom' });
  });
});

describe('disconnectFolder', () => {
  test('забывает папку и ставит статус no-folder, файлы на диске остаются', async () => {
    const root = await connected();
    root.put('old/review.json', '{}');
    await folder.disconnectFolder();
    assert.equal(await folder.getDir(), undefined);
    assert.deepEqual(status(), { state: 'no-folder' });
    assert.ok(root.has('old/review.json'));
  });
});

describe('writeReview', () => {
  test('создаёт подпапку «Название — дата» с отчётом, JSON и скриншотами', async () => {
    const root = new MemDir('uniform-reviews-results');
    const issues = [makeIssue({ group: 'Кнопка', screenshot: PNG }), makeIssue({ group: 'Без скрина', screenshot: '' }), makeIssue({ group: 'Фото', screenshot: JPEG })];
    const review = makeReview({ title: 'Оплата', createdAt: Date.UTC(2026, 9, 16, 9), issues });
    const sub = await folder.writeReview(root, review);
    assert.equal(sub, 'Оплата — 2026-10-16');
    assert.deepEqual(root.list(sub), ['review.json', 'screenshots', 'Отчёт.html']);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.length, 2);
    assert.match(shots[0], /^01 — Кнопка — [0-9a-f]{6}\.png$/);
    assert.match(shots[1], /^03 — Фото — [0-9a-f]{6}\.jpg$/);
    // PNG-байты записаны как есть
    const bytes = root.at(`${sub}/screenshots/${shots[0]}`).bytes;
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(bytes.length, Buffer.from(PNG.split(',')[1], 'base64').length);
  });

  test('review.json: формат, ISO-даты, группы, номера, ссылки на файлы, без base64', async () => {
    const root = new MemDir('uniform-reviews-results');
    const issues = [makeIssue({ group: 'Кнопка', note: 'красная' }), makeIssue({ group: 'Модалка', screenshot: '' })];
    const review = makeReview({ author: undefined, devTicketUrl: undefined, issues });
    const sub = await folder.writeReview(root, review);
    const json = JSON.parse(root.at(`${sub}/review.json`).text());
    assert.equal(json.format, 'uniform-design-checker');
    assert.equal(json.version, 1);
    assert.equal(json.id, review.id);
    assert.equal(json.author, '');
    assert.equal(json.devTicketUrl, '');
    assert.equal(json.designTicketUrl, review.designTicketUrl);
    assert.equal(json.createdAt, new Date(review.createdAt).toISOString());
    assert.deepEqual(json.groups.map((g) => [g.id, g.title]), [['g-Кнопка', 'Кнопка'], ['g-Модалка', 'Модалка']]);
    assert.equal(json.groups[0].createdAt, new Date(review.groups[0].createdAt).toISOString());
    assert.equal(json.issues[0].number, 1);
    assert.equal(json.issues[0].groupId, 'g-Кнопка');
    assert.equal(json.issues[0].note, 'красная');
    assert.equal(json.issues[0].severityLabel, undefined);
    assert.match(json.issues[0].screenshotFile, /^screenshots\/01 — Кнопка — .+\.png$/);
    assert.ok(root.has(`${sub}/${json.issues[0].screenshotFile}`));
    assert.equal(json.issues[1].screenshotFile, null);
    assert.equal(json.issues[0].screenshot, undefined);
    assert.doesNotMatch(root.at(`${sub}/review.json`).text(), /base64/);
    assert.equal(json.issues[0].createdAt, new Date(issues[0].createdAt).toISOString());
    assert.deepEqual(json.issues[0].element, issues[0].element);
  });

  test('Отчёт.html — самодостаточный отчёт ревью', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = makeReview({ title: 'Главная', issues: [makeIssue()] });
    const sub = await folder.writeReview(root, review);
    const html = root.at(`${sub}/Отчёт.html`).text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Единообразие блоков — Главная<\/title>/);
    assert.match(html, /data:image\/png;base64/);
  });

  test('имя подпапки фиксируется: переименование ревью не плодит папки', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = makeReview({ title: 'Старое' });
    const a = await folder.writeReview(root, review);
    review.title = 'Новое';
    const b = await folder.writeReview(root, review);
    assert.equal(a, b);
    assert.deepEqual(root.list(), [a]);
    assert.equal(names()[review.id], a);
  });

  test('одинаковые названия и даты → «(2)», «(3)»', async () => {
    const root = new MemDir('uniform-reviews-results');
    const subs = [];
    for (let i = 0; i < 3; i++) subs.push(await folder.writeReview(root, makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2) })));
    assert.deepEqual(subs, ['Ревью — 2026-01-02', 'Ревью — 2026-01-02 (2)', 'Ревью — 2026-01-02 (3)']);
  });

  test('параллельная запись разных ревью не теряет словарь имён и не путает папки', async () => {
    const root = new MemDir('uniform-reviews-results');
    const reviews = Array.from({ length: 8 }, () => makeReview({ title: 'Одинаковое', createdAt: Date.UTC(2026, 0, 2) }));
    const subs = await Promise.all(reviews.map((r) => folder.writeReview(root, r)));
    assert.equal(new Set(subs).size, 8);
    assert.equal(Object.keys(names()).length, 8);
    reviews.forEach((r, k) => assert.equal(names()[r.id], subs[k]));
  });

  test('удаляет скриншоты удалённых вариантов, но не чужие файлы', async () => {
    const root = new MemDir('uniform-reviews-results');
    const keep = makeIssue({ group: 'Оставить' });
    const drop = makeIssue({ group: 'Удалить' });
    const review = makeReview({ issues: [keep, drop] });
    const sub = await folder.writeReview(root, review);
    root.put(`${sub}/screenshots/моя заметка.png`, 'x');
    root.put(`${sub}/screenshots/вложенная/01 — a — abcdef.png`, 'x');
    review.issues = [keep];
    await folder.writeReview(root, review);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.filter((n) => n.includes('Оставить')).length, 1);
    assert.equal(shots.filter((n) => n.includes('Удалить')).length, 0);
    assert.ok(shots.includes('моя заметка.png'));
    assert.ok(shots.includes('вложенная'));
  });

  test('перенумерация при перестановке: старые имена удаляются, новые создаются', async () => {
    const root = new MemDir('uniform-reviews-results');
    const a = makeIssue({ group: 'A' });
    const b = makeIssue({ group: 'B' });
    const review = makeReview({ issues: [a, b] });
    const sub = await folder.writeReview(root, review);
    review.issues = [b, a];
    await folder.writeReview(root, review);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.length, 2);
    assert.ok(shots[0].startsWith('01 — B'));
    assert.ok(shots[1].startsWith('02 — A'));
  });

  test('переименование группы переименовывает файлы её скриншотов', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = makeReview({ issues: [makeIssue({ group: 'Кнопка' })] });
    const sub = await folder.writeReview(root, review);
    review.groups[0].title = 'Кнопка удаления';
    await folder.writeReview(root, review);
    const shots = root.list(`${sub}/screenshots`);
    assert.equal(shots.length, 1);
    assert.match(shots[0], /^01 — Кнопка удаления — /);
  });

  test('не переписывает скриншот, если размер не изменился', async () => {
    const root = new MemDir('uniform-reviews-results');
    const issue = makeIssue({ screenshot: PNG });
    const review = makeReview({ issues: [issue] });
    const sub = await folder.writeReview(root, review);
    const [name] = root.list(`${sub}/screenshots`);
    const file = root.at(`${sub}/screenshots/${name}`);
    await folder.writeReview(root, review);
    assert.equal(file.writes, 1);
    issue.screenshot = PNG_2;
    await folder.writeReview(root, review);
    assert.equal(file.writes, 2);
  });

  test('словарь имён потерян: чужую папку с тем же именем не перезаписывает', async () => {
    const root = new MemDir('uniform-reviews-results');
    const old = makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2), issues: [makeIssue({ title: 'Старое' })] });
    const sub = await folder.writeReview(root, old);
    const oldShots = root.list(`${sub}/screenshots`);
    chrome.storage.local.data.delete('folderNames'); // как после переустановки расширения
    const fresh = makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2), issues: [makeIssue({ title: 'Новое' })] });
    assert.equal(await folder.writeReview(root, fresh), 'Ревью — 2026-01-02 (2)');
    assert.deepEqual(root.list(`${sub}/screenshots`), oldShots);
    assert.equal(JSON.parse(root.at(`${sub}/review.json`).text()).id, old.id);
  });

  test('словарь имён потерян: своя папка (тот же id в review.json) переиспользуется', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = makeReview({ title: 'Своё' });
    const sub = await folder.writeReview(root, review);
    chrome.storage.local.data.delete('folderNames');
    assert.equal(await folder.writeReview(root, review), sub);
    assert.deepEqual(root.list(), [sub]);
  });

  test('ошибка записи пробрасывается', async () => {
    const root = new MemDir('uniform-reviews-results');
    root.failWrites = 'Диск только для чтения';
    await assert.rejects(folder.writeReview(root, makeReview({ issues: [makeIssue()] })), /только для чтения/);
  });
});

describe('syncReview (фоновое автосохранение)', () => {
  test('нет папки → статус no-folder', async () => {
    await folder.syncReview(makeReview());
    assert.deepEqual(status(), { state: 'no-folder' });
  });

  test('нет разрешения → статус no-permission и ничего не пишется', async () => {
    const root = await connected('prompt');
    await folder.syncReview(makeReview());
    assert.equal(status().state, 'no-permission');
    assert.equal(status().dirName, 'uniform-reviews-results');
    assert.deepEqual(root.list(), []);
    assert.equal(root.permission, 'prompt', 'фон не должен запрашивать разрешение');
  });

  test('успех → файлы записаны, статус ok с подпапкой и временем', async () => {
    const root = await connected();
    const before = Date.now();
    const review = makeReview({ title: 'Синк' });
    await store.importReview(review);
    await folder.syncReview(review);
    const s = status();
    assert.equal(s.state, 'ok');
    assert.match(s.lastFolder, /^Синк — /);
    assert.ok(s.lastSyncAt >= before);
    assert.equal(s.error, '');
    assert.ok(root.has(`${s.lastFolder}/review.json`));
  });

  test('ошибка записи → статус error, исключение не выбрасывается', async () => {
    const root = await connected();
    root.failWrites = 'Нет места на диске';
    const review = makeReview({ issues: [makeIssue()] });
    await store.importReview(review);
    await folder.syncReview(review);
    assert.deepEqual({ state: status().state, error: status().error }, { state: 'error', error: 'Нет места на диске' });
  });

  test('ревью, удалённое до записи, не воскрешается на диске', async () => {
    const root = await connected();
    await folder.syncReview(makeReview({ title: 'Удалённое' }));
    assert.deepEqual(root.list(), []);
  });

  test('пишется свежая версия из хранилища, а не устаревший объект', async () => {
    const root = await connected();
    const review = makeReview({ title: 'Версии' });
    await store.importReview(review);
    await store.updateReview(review.id, { author: 'Новый автор' });
    await folder.syncReview(review);
    assert.equal(JSON.parse(root.at(`${status().lastFolder}/review.json`).text()).author, 'Новый автор');
  });
});

describe('writeAll', () => {
  test('пишет все ревью и обновляет статус', async () => {
    const root = new MemDir('uniform-reviews-results');
    await folder.writeAll(root, [makeReview({ title: 'A' }), makeReview({ title: 'B' })]);
    assert.equal(root.list().length, 2);
    assert.equal(status().state, 'ok');
  });
  test('пустой список — только статус', async () => {
    const root = new MemDir('uniform-reviews-results');
    await folder.writeAll(root, []);
    assert.deepEqual(root.list(), []);
    assert.equal(status().state, 'ok');
  });
});

describe('reviewFolderName', () => {
  test('берёт имя из словаря', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    assert.equal(await folder.reviewFolderName(review), sub);
  });

  test('без записи в словаре угадывает стандартное имя, если такая папка есть', async () => {
    const root = await connected();
    const review = makeReview({ title: 'Потерянное', createdAt: Date.UTC(2026, 4, 5) });
    root.put('Потерянное — 2026-05-05/review.json', '{}');
    assert.equal(await folder.reviewFolderName(review), 'Потерянное — 2026-05-05');
  });

  test('не угадывает, если папки нет на диске', async () => {
    await connected();
    assert.equal(await folder.reviewFolderName(makeReview()), null);
  });

  test('не угадывает папку, принадлежащую другому ревью', async () => {
    const root = await connected();
    const other = makeReview({ title: 'Двойник', createdAt: Date.UTC(2026, 0, 1) });
    await folder.writeReview(root, other);
    const me = makeReview({ title: 'Двойник', createdAt: Date.UTC(2026, 0, 1) });
    assert.equal(await folder.reviewFolderName(me), null);
  });

  test('без названия/даты, без папки или без разрешения → null', async () => {
    assert.equal(await folder.reviewFolderName({ id: 'x' }), null);
    assert.equal(await folder.reviewFolderName(makeReview()), null);
    const root = await connected('prompt');
    root.put(`${makeReview().title} — 2026-10-16/x`, '');
    assert.equal(await folder.reviewFolderName(makeReview()), null);
  });
});

describe('deleteReviewFolder', () => {
  test('удаляет папку ревью целиком и запись в словаре, соседей не трогает', async () => {
    const root = await connected();
    root.put('.gitkeep', '');
    const a = makeReview({ title: 'A', issues: [makeIssue()] });
    const b = makeReview({ title: 'B' });
    const subA = await folder.writeReview(root, a);
    const subB = await folder.writeReview(root, b);
    const res = await folder.deleteReviewFolder(a);
    assert.deepEqual(res, { deleted: true, name: subA });
    assert.deepEqual(root.list(), ['.gitkeep', subB]);
    assert.equal(names()[a.id], undefined);
    assert.equal(names()[b.id], subB);
  });

  test('ревью не сохранялось → not-saved', async () => {
    await connected();
    assert.deepEqual(await folder.deleteReviewFolder(makeReview()), { deleted: false, reason: 'not-saved' });
  });

  test('папку отключили после сохранения → no-folder, имя подпапки известно', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    await folder.clearDir();
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: false, name: sub, reason: 'no-folder' });
  });

  test('нет разрешения → no-permission; с request=true разрешение запрашивается', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    root.permission = 'prompt';
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: false, name: sub, reason: 'no-permission' });
    assert.ok(root.has(sub));
    assert.deepEqual(await folder.deleteReviewFolder(review, { request: true }), { deleted: true, name: sub });
    assert.ok(!root.has(sub));
  });

  test('папку уже удалили вручную — это не ошибка', async () => {
    const root = await connected();
    const review = makeReview();
    const sub = await folder.writeReview(root, review);
    await root.removeEntry(sub, { recursive: true });
    assert.deepEqual(await folder.deleteReviewFolder(review), { deleted: true, name: sub });
  });

  test('прочие ошибки удаления пробрасываются', async () => {
    const root = await connected();
    const review = makeReview();
    await folder.writeReview(root, review);
    root.removeEntry = async () => {
      const e = new Error('Файл занят');
      e.name = 'NoModificationAllowedError';
      throw e;
    };
    await assert.rejects(folder.deleteReviewFolder(review), /Файл занят/);
  });
});

test('RESULTS_DIR совпадает с папкой в репозитории', () => {
  assert.equal(folder.RESULTS_DIR, 'uniform-reviews-results');
});

describe('importFromFolder (восстановление после переустановки)', () => {
  // Пишем ревью на диск, затем «переустанавливаем» расширение — новое окружение с пустым chrome.storage.
  async function savedThenReinstalled(reviews) {
    const root = new MemDir('uniform-reviews-results');
    for (const r of reviews) await folder.writeReview(root, r);
    ({ chrome } = installEnv());
    return root;
  }

  test('восстанавливает ревью целиком: поля, даты, группы, варианты и скриншоты', async () => {
    const issues = [makeIssue({ group: 'Кнопка', screenshot: PNG }), makeIssue({ group: 'Кнопка', screenshot: '', note: 'без скриншота' }), makeIssue({ group: 'Фото', screenshot: JPEG, updatedAt: 123 })];
    const original = makeReview({ title: 'Оплата', issues });
    original.groups[0].description = 'Красная, 32px';
    const root = await savedThenReinstalled([structuredClone(original)]);

    const result = await folder.importFromFolder(root);
    assert.deepEqual(result, { found: 1, imported: 1, failed: [], missingShots: 0 });
    const expected = structuredClone(original);
    delete expected.issues[1].screenshot; // пустой скриншот на диск не пишется — после восстановления поля просто нет
    assert.deepEqual(await store.getReview(original.id), expected);
    const [meta] = await store.listReviews();
    assert.equal(meta.updatedAt, original.updatedAt, 'дата изменения не сдвигается');
    assert.equal(meta.issueCount, 3);
    assert.match(meta.search, /оплата/);
  });

  test('после восстановления текущим становится последнее изменённое ревью; текущее не перебивается', async () => {
    const old = makeReview({ title: 'Давнее', updatedAt: Date.UTC(2026, 0, 1) });
    const fresh = makeReview({ title: 'Свежее', updatedAt: Date.UTC(2026, 5, 1) });
    const root = await savedThenReinstalled([old, fresh]);
    await folder.importFromFolder(root);
    assert.equal(await store.getActiveReviewId(), fresh.id);

    ({ chrome } = installEnv());
    const mine = await store.createReview({ title: 'Уже начатое' });
    await folder.importFromFolder(root);
    assert.equal(await store.getActiveReviewId(), mine.id);
  });

  test('восстанавливает словарь подпапок: следующее сохранение пишет в ту же папку', async () => {
    const a = makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2) });
    const b = makeReview({ title: 'Ревью', createdAt: Date.UTC(2026, 0, 2) });
    const root = await savedThenReinstalled([a, b]);
    await folder.importFromFolder(root);
    assert.deepEqual(names(), { [a.id]: 'Ревью — 2026-01-02', [b.id]: 'Ревью — 2026-01-02 (2)' });
    await folder.writeReview(root, await store.getReview(b.id));
    assert.deepEqual(root.list(), ['Ревью — 2026-01-02', 'Ревью — 2026-01-02 (2)']);
  });

  test('ревью, которые уже есть в расширении, не перезаписываются', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = await store.createReview({ title: 'Живое' });
    await folder.writeReview(root, review);
    await store.updateReview(review.id, { title: 'Переименовано' });
    const result = await folder.importFromFolder(root);
    assert.equal(result.found, 1);
    assert.equal(result.imported, 0);
    assert.equal((await store.getReview(review.id)).title, 'Переименовано');
  });

  test('копии одной папки — ревью восстанавливается один раз', async () => {
    const review = makeReview({ title: 'Копия' });
    const root = await savedThenReinstalled([review]);
    const [sub] = root.list();
    root.children.set(`${sub} — копия`, root.at(sub));
    const result = await folder.importFromFolder(root);
    assert.equal(result.found, 2);
    assert.equal(result.imported, 1);
    assert.equal((await store.listReviews()).length, 1);
    assert.equal(names()[review.id], sub);
  });

  test('повреждённый review.json — в failed; чужие папки и файлы игнорируются', async () => {
    const root = await savedThenReinstalled([makeReview({ title: 'Целое' })]);
    root.put('Битое — 2026-10-16/review.json', '{ не json');
    root.put('Чужой формат/review.json', JSON.stringify({ format: 'other', id: 'x', issues: [] }));
    root.put('Будущее/review.json', JSON.stringify({ format: 'uniform-design-checker', version: 2, id: 'y', issues: [] }));
    root.put('Просто папка/notes.txt', 'x');
    root.put('.DS_Store', 'x');
    const result = await folder.importFromFolder(root);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.failed, ['Битое — 2026-10-16', 'Будущее', 'Чужой формат']);
    assert.deepEqual((await store.listReviews()).map((r) => r.title), ['Целое']);
  });

  test('ревью Design Review Checker: замечания с одним названием становятся вариантами одной группы', async () => {
    const root = new MemDir('uniform-reviews-results');
    const legacy = {
      format: 'design-review-checker',
      version: 1,
      id: 'old',
      title: 'Старое',
      issues: [
        { number: 1, id: 'a', title: 'Кнопка', description: 'Должна быть красной', severity: 'high', severityLabel: 'Высокая', mockupUrl: 'https://figma.com/x', screenshotFile: 'screenshots/01 — Кнопка — aaaaaa.png', fixImages: [{ id: 'f', file: 'screenshots/01 — Визуальное пояснение — ffffff.png' }] },
        { number: 2, id: 'b', title: 'Кнопка', severity: 'low', screenshotFile: null },
        { number: 3, id: 'c', title: 'Модалка', screenshotFile: null },
      ],
    };
    root.put('Старое/review.json', JSON.stringify(legacy));
    root.put('Старое/screenshots/01 — Кнопка — aaaaaa.png', Buffer.from(PNG.split(',')[1], 'base64'));
    root.put('Старое/screenshots/01 — Визуальное пояснение — ffffff.png', 'x');
    const result = await folder.importFromFolder(root);
    assert.deepEqual(result, { found: 1, imported: 1, failed: [], missingShots: 0 });
    const review = await store.getReview('old');
    assert.deepEqual(review.groups.map((g) => g.title), ['Кнопка', 'Модалка']);
    assert.equal(review.groups[0].description, 'Должна быть красной');
    assert.equal(review.groups[0].mockupUrl, 'https://figma.com/x');
    assert.deepEqual(review.issues.map((i) => i.groupId), [review.groups[0].id, review.groups[0].id, review.groups[1].id]);
    assert.equal(review.issues[0].screenshot, PNG);
    for (const gone of ['title', 'severity', 'fixImages', 'description']) assert.equal(review.issues[0][gone], undefined, gone);
  });

  test('повреждённые записи групп отбрасываются, их варианты получают группу заново', async () => {
    const root = new MemDir('uniform-reviews-results');
    root.put(
      'Р/review.json',
      JSON.stringify({ format: 'uniform-design-checker', version: 1, id: 'r', title: 'Р', groups: [null, { title: 'без id' }, { id: 'g', title: '  ' }], issues: [{ id: 'i', groupId: 'g' }, { id: 'j', groupId: 'x' }] }),
    );
    await folder.importFromFolder(root);
    const review = await store.getReview('r');
    assert.deepEqual(review.groups.map((g) => [g.id, g.title]), [['g', 'Без названия'], [review.groups[1].id, 'Без группы']]);
    assert.deepEqual(review.issues.map((i) => i.groupId), ['g', review.groups[1].id]);
  });

  test('пропавший скриншот: вариант восстанавливается без картинки', async () => {
    const issue = makeIssue({ note: 'Скрин удалили' });
    const root = await savedThenReinstalled([makeReview({ issues: [issue] })]);
    const [sub] = root.list();
    for (const name of root.list(`${sub}/screenshots`)) await root.at(`${sub}/screenshots`).removeEntry(name);
    const result = await folder.importFromFolder(root);
    assert.equal(result.missingShots, 1);
    const [restored] = (await store.getAllReviews())[0].issues;
    assert.equal(restored.note, 'Скрин удалили');
    assert.equal(restored.screenshot, undefined);
  });

  test('путь к скриншоту не выходит за пределы папки ревью', async () => {
    const root = new MemDir('uniform-reviews-results');
    root.put('secret.png', 'x');
    root.put('Ревью/review.json', JSON.stringify({ format: 'uniform-design-checker', version: 1, id: 'r1', title: 'Ревью', issues: [{ id: 'i1', title: 'A', screenshotFile: '../secret.png' }] }));
    const result = await folder.importFromFolder(root);
    assert.equal(result.missingShots, 1);
    assert.equal((await store.getReview('r1')).issues[0].screenshot, undefined);
  });

  test('пустая папка — ничего не найдено', async () => {
    assert.deepEqual(await folder.importFromFolder(new MemDir('uniform-reviews-results')), { found: 0, imported: 0, failed: [], missingShots: 0 });
  });

  test('hasSavedReviews', async () => {
    const root = new MemDir('x');
    root.put('a/notes.txt', 'x');
    assert.equal(await folder.hasSavedReviews(root), false);
    await folder.writeReview(root, makeReview());
    assert.equal(await folder.hasSavedReviews(root), true);
  });

  test('importSummary', () => {
    assert.equal(folder.importSummary({ imported: 0, failed: [], missingShots: 0 }), '');
    assert.equal(folder.importSummary({ imported: 2, failed: [], missingShots: 0 }), 'Восстановлено ревью из папки: 2.');
    assert.equal(
      folder.importSummary({ imported: 1, failed: ['A', 'B'], missingShots: 3 }),
      'Восстановлено ревью из папки: 1. Не найдено скриншотов: 3 — эти варианты восстановлены без картинок. Не удалось прочитать review.json в папках: A, B.',
    );
  });
});

describe('несохранённые на диск изменения (доступ есть только пока открыта страница расширения)', () => {
  test('ревью без записи на диск — несохранённое; после записи — нет; после правки — снова да', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = await store.createReview({ title: 'R' });
    assert.deepEqual((await folder.unsavedReviews()).map((m) => m.id), [review.id]);
    await folder.writeReview(root, await store.getReview(review.id));
    assert.deepEqual(await folder.unsavedReviews(), []);
    await sleepMs(2);
    await store.updateReview(review.id, { title: 'R2' });
    assert.deepEqual((await folder.unsavedReviews()).map((m) => m.id), [review.id]);
  });

  test('syncReview без доступа ничего не пишет — изменение остаётся несохранённым', async () => {
    const root = await connected('prompt');
    const review = await store.createReview({ title: 'С сайта' });
    await folder.syncReview(review);
    assert.deepEqual(root.list(), []);
    assert.equal((await folder.unsavedReviews()).length, 1);
  });

  test('flushUnsaved: с доступом дописывает все несохранённые, без доступа — ничего и без запроса', async () => {
    const root = await connected('prompt');
    await store.createReview({ title: 'A' });
    await store.createReview({ title: 'B' });
    assert.equal(await folder.flushUnsaved(), 0);
    assert.equal(root.permission, 'prompt', 'разрешение не запрашивается');
    root.permission = 'granted';
    assert.equal(await folder.flushUnsaved(), 2);
    assert.equal(root.list().length, 2);
    assert.deepEqual(await folder.unsavedReviews(), []);
    assert.equal(await folder.flushUnsaved(), 0, 'повторно ничего не пишется');
  });

  test('flushUnsaved: ошибка записи уходит в статус, исключения нет', async () => {
    const root = await connected();
    root.failWrites = 'Нет места';
    await store.addIssue((await store.createReview({ title: 'X' })).id, makeIssue());
    assert.equal(await folder.flushUnsaved(), 0);
    assert.deepEqual({ state: status().state, error: status().error }, { state: 'error', error: 'Нет места' });
  });

  test('syncReview с доступом заодно дописывает изменения, копившиеся без него', async () => {
    const root = await connected('prompt');
    await store.createReview({ title: 'Копилось' });
    root.permission = 'granted'; // открыли страницу расширения
    const now = await store.createReview({ title: 'Сейчас' });
    await folder.syncReview(now);
    assert.equal(root.list().length, 2);
    assert.deepEqual(await folder.unsavedReviews(), []);
  });

  test('восстановленные из папки ревью уже на диске — несохранёнными не считаются', async () => {
    const root = new MemDir('uniform-reviews-results');
    await folder.writeReview(root, makeReview({ title: 'С диска' }));
    ({ chrome } = installEnv());
    await folder.importFromFolder(root);
    assert.deepEqual(await folder.unsavedReviews(), []);
  });
});

describe('checkFolderContents (сверка расширения с папкой)', () => {
  async function savedReviews(titles, perm = 'granted') {
    const root = await connected(perm);
    const reviews = [];
    for (const title of titles) {
      const r = await store.createReview({ title });
      await folder.writeReview(root, await store.getReview(r.id));
      reviews.push(r);
    }
    return { root, reviews };
  }

  test('всё на месте — пропавших нет', async () => {
    await savedReviews(['A', 'B']);
    assert.deepEqual(await folder.checkFolderContents(), { checked: true, missing: [], found: 2, folderGone: false, dirName: 'uniform-reviews-results' });
  });

  test('папку очистили вручную — все сохранённые ревью пропали', async () => {
    const { root, reviews } = await savedReviews(['A', 'B']);
    root.children.clear();
    const check = await folder.checkFolderContents();
    assert.equal(check.found, 0);
    assert.deepEqual(check.missing.map((m) => m.id).sort(), reviews.map((r) => r.id).sort());
  });

  test('удалили одну подпапку — пропало только это ревью', async () => {
    const { root, reviews } = await savedReviews(['A', 'B']);
    await root.removeEntry(names()[reviews[0].id], { recursive: true });
    const check = await folder.checkFolderContents();
    assert.deepEqual(check.missing.map((m) => m.title), ['A']);
    assert.equal(check.found, 1);
  });

  test('переименованная подпапка не считается пропавшей: ревью ищется по id в review.json', async () => {
    const { root, reviews } = await savedReviews(['A']);
    const sub = root.at(names()[reviews[0].id]);
    root.children.delete(sub.name);
    sub.name = 'Переименовал';
    root.children.set(sub.name, sub);
    assert.deepEqual((await folder.checkFolderContents()).missing, []);
  });

  test('ни разу не сохранённые ревью — не пропавшие, а несохранённые', async () => {
    await connected();
    await store.createReview({ title: 'Ещё не на диске' });
    assert.deepEqual((await folder.checkFolderContents()).missing, []);
  });

  test('без доступа или без папки проверка не выполняется', async () => {
    const { root } = await savedReviews(['A'], 'prompt');
    root.children.clear();
    assert.deepEqual(await folder.checkFolderContents(), { checked: false, missing: [], found: 0, folderGone: false });
    assert.equal(root.permission, 'prompt', 'разрешение не запрашивается');
    await folder.clearDir();
    assert.equal((await folder.checkFolderContents()).checked, false);
  });

  test('папку удалили целиком — folderGone, все сохранённые ревью пропали', async () => {
    const { root } = await savedReviews(['A']);
    root.entries = async function* () {
      const e = new Error('Каталог не найден');
      e.name = 'NotFoundError';
      throw e;
    };
    const check = await folder.checkFolderContents();
    assert.equal(check.folderGone, true);
    assert.deepEqual(check.missing.map((m) => m.title), ['A']);
  });

  test('в папке есть повреждённый review.json — пропавшими никого не считаем', async () => {
    const { root } = await savedReviews(['A']);
    root.children.clear();
    root.put('Чьё-то ревью/review.json', '{ битый json');
    assert.deepEqual((await folder.checkFolderContents()).missing, []);
  });

  test('resaveMissing записывает пропавшие ревью заново', async () => {
    const { root, reviews } = await savedReviews(['A', 'B']);
    root.children.clear();
    assert.equal(await folder.resaveMissing(reviews.map((r) => r.id)), 2);
    assert.equal(root.list().length, 2);
    assert.deepEqual((await folder.checkFolderContents()).missing, []);
  });

  test('resaveMissing без доступа: ревью становятся несохранёнными и допишутся позже', async () => {
    const { root, reviews } = await savedReviews(['A']);
    root.children.clear();
    root.permission = 'prompt';
    assert.equal(await folder.resaveMissing([reviews[0].id]), 0);
    assert.deepEqual((await folder.unsavedReviews()).map((m) => m.id), [reviews[0].id]);
  });

  test('forgetMissing удаляет ревью из расширения и забывает их подпапки; остальные не трогает', async () => {
    const { root, reviews } = await savedReviews(['A', 'B']);
    await root.removeEntry(names()[reviews[0].id], { recursive: true });
    await folder.forgetMissing([reviews[0].id]);
    assert.deepEqual((await store.listReviews()).map((m) => m.title), ['B']);
    assert.equal(names()[reviews[0].id], undefined);
    assert.equal(chrome.storage.local.data.get('folderSynced')[reviews[0].id], undefined);
    assert.deepEqual((await folder.checkFolderContents()).missing, []);
    assert.equal(root.list().length, 1, 'папка оставшегося ревью на месте');
  });
});

describe('версия формата записи', () => {
  test('ревью, записанные прежним форматом (или старым кодом), считаются несохранёнными', async () => {
    const root = await connected();
    const r = await store.createReview({ title: 'Старый формат' });
    await chrome.storage.local.set({ folderSynced: { [r.id]: Date.now() + 1e6 } }); // так писал прежний код
    assert.deepEqual((await folder.unsavedReviews()).map((m) => m.id), [r.id]);
    assert.equal(await folder.flushUnsaved(), 1);
    assert.deepEqual(await folder.unsavedReviews(), []);
    assert.equal(chrome.storage.local.data.get('folderSynced')[r.id].v, folder.WRITER_VERSION);
    assert.ok(root.list().length);
  });
});

describe('regainAccessOnClick', () => {
  function fakeDoc() {
    const listeners = new Set();
    return {
      addEventListener: (type, fn) => type === 'click' && listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      down: (target = { closest: () => null }) => [...listeners].forEach((fn) => fn({ target })),
      get count() {
        return listeners.size;
      },
    };
  }

  test('первый клик запрашивает доступ и дописывает несохранённое; слушатель снимается', async () => {
    const root = await connected('prompt');
    await store.createReview({ title: 'Ждёт' });
    const doc = fakeDoc();
    const done = folder.regainAccessOnClick(doc, root);
    assert.equal(doc.count, 1);
    doc.down();
    assert.deepEqual(await done, { state: 'granted', error: '' });
    assert.equal(doc.count, 0);
    assert.equal(root.list().length, 1);
  });

  test('клик внутри ignore пропускается; отказ браузера — состояние prompt без исключения', async () => {
    const root = new MemDir('uniform-reviews-results', { permission: 'prompt', grantOnRequest: false });
    await folder.setDir(root);
    const doc = fakeDoc();
    const done = folder.regainAccessOnClick(doc, root, { ignore: '#folder' });
    doc.down({ closest: (sel) => (sel === '#folder' ? {} : null) });
    assert.equal(doc.count, 1, 'клик по блоку папки не считается');
    doc.down();
    assert.deepEqual(await done, { state: 'prompt', error: '' });
    assert.deepEqual(root.list(), []);
  });
});

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

describe('очередь записи на диск', () => {
  test('записи идут строго по очереди, даже если запущены одновременно', async (t) => {
    const root = new MemDir('uniform-reviews-results');
    const a = makeReview({ title: 'Первое', issues: [makeIssue(), makeIssue({ screenshot: JPEG })] });
    const b = makeReview({ title: 'Второе', issues: [makeIssue(), makeIssue({ screenshot: JPEG })] });
    const calls = [];
    const original = MemDir.prototype.getFileHandle;
    t.mock.method(MemDir.prototype, 'getFileHandle', async function (...args) {
      calls.push(this);
      await new Promise((r) => setTimeout(r, 1)); // как настоящий диск: каждая операция — отдельная задача
      return original.apply(this, args);
    });
    const [subA, subB] = await Promise.all([folder.writeReview(root, a), folder.writeReview(root, b)]);
    const owner = (dir) => (dir === root.at(subA) || dir === root.at(`${subA}/screenshots`) ? 'A' : 'B');
    const order = calls.map(owner).join('');
    assert.match(order, /^A+B+$/, order);
  });

  test('сбой посреди записи не удаляет сохранённые скриншоты', async () => {
    const root = new MemDir('uniform-reviews-results');
    const review = makeReview({ issues: [makeIssue(), makeIssue({ screenshot: JPEG })] });
    const sub = await folder.writeReview(root, review);
    const before = root.list(`${sub}/screenshots`);
    review.issues.shift();
    review.issues.push(makeIssue({ screenshot: PNG_2 })); // новый скриншот записать не получится
    root.at(sub).failWrites = 'Браузер остановил фоновый скрипт';
    root.at(`${sub}/screenshots`).failWrites = 'Браузер остановил фоновый скрипт';
    await assert.rejects(folder.writeReview(root, review), /остановил/);
    assert.deepEqual(root.list(`${sub}/screenshots`), before, 'ничего не удалено, пока не записано новое');
  });
});
