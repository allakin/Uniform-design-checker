import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEADER,
  LOG_FORMAT,
  parseLog,
  humanize,
  classify,
  entries,
  previousTag,
  renderSection,
  releaseNotes,
  plural,
  notRussian,
  prependSection,
  syncDraft,
  publishRelease,
  touchesExtension,
  nextVersion,
  withVersion,
  withLockVersion,
} from '../../scripts/changelog-prepend.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const commit = (subject, body = '', extra = {}) => ({ hash: HASH, author: 'Dev', date: '2026-10-16', subject, body, ...extra });
const REPO = 'o/r';

describe('сообщения коммитов', () => {
  test('parseLog разбирает формат LOG_FORMAT, включая многострочное тело', () => {
    assert.match(LOG_FORMAT, /%H.*%an.*%cs.*%s.*%b/);
    const log = `${HASH}\x1fDev\x1f2026-10-15\x1ffeat: экспорт\x1fстрока 1\nРелиз: Экспорт в PDF\n\x1e\n${HASH}\x1fBot\x1f2026-10-16\x1fchore: x\x1f\x1e\n`;
    const [a, b] = parseLog(log);
    assert.deepEqual(a, { hash: HASH, author: 'Dev', date: '2026-10-15', subject: 'feat: экспорт', body: 'строка 1\nРелиз: Экспорт в PDF' });
    assert.equal(b.subject, 'chore: x');
    assert.equal(b.body, '');
    assert.deepEqual(parseLog(''), []);
  });

  test('humanize: инфинитив → прошедшее время («Добавили …»), первое предложение, без точки', () => {
    assert.equal(humanize('добавить экспорт отчёта в PDF'), 'Добавили экспорт отчёта в PDF');
    assert.equal(humanize('Исправить падение попапа. Подробности в тикете'), 'Исправили падение попапа');
    assert.equal(humanize('починить сохранение;'), 'Исправили сохранение');
    assert.equal(humanize('новая плашка релиза'), 'Новая плашка релиза');
    assert.equal(humanize('Добавлена тёмная тема'), 'Добавлена тёмная тема');
    assert.equal(humanize('add hotkey'), 'Add hotkey');
    const long = humanize(`Обновить ${'очень '.repeat(40)}длинный текст`);
    assert.ok(long.length <= 120 && long.endsWith('…'), long);
  });

  test('classify: группы Conventional Commits, скоуп в релиз не попадает', () => {
    assert.deepEqual(classify(commit('feat(popup): добавить экспорт')), { group: 'Новое', text: 'Добавили экспорт' });
    assert.equal(classify(commit('fix: исправить падение')).group, 'Исправления');
    assert.equal(classify(commit('perf: ускорить поиск')).group, 'Улучшения');
    assert.equal(classify(commit('refactor: вынести store')).group, 'Рефакторинг');
    assert.equal(classify(commit('docs: описать установку')).group, 'Документация');
    assert.equal(classify(commit('test: покрыть folder.js')).group, 'Тесты');
    assert.equal(classify(commit('ci: кешировать npm')).group, 'Служебное');
    assert.equal(classify(commit('wip: что-то')).group, 'Изменения');
  });

  test('classify: ломающие изменения — по «!» и по BREAKING CHANGE в теле', () => {
    assert.equal(classify(commit('fix(content)!: изменить формат review.json')).group, 'Ломающие изменения');
    assert.equal(classify(commit('feat: новый формат', 'BREAKING CHANGE: старые файлы не читаются')).group, 'Ломающие изменения');
  });

  test('classify: коммит без префикса — группа по глаголу', () => {
    assert.deepEqual(classify(commit('Починить сохранение скриншота')), { group: 'Исправления', text: 'Исправили сохранение скриншота' });
    assert.equal(classify(commit('Добавить тёмную тему')).group, 'Новое');
    assert.equal(classify(commit('Ускорить поиск')).group, 'Улучшения');
    assert.equal(classify(commit('Обновить иконки')).group, 'Изменения');
    assert.equal(classify(commit('Добавлена тёмная тема')).group, 'Новое');
    assert.equal(classify(commit('Initial commit')).group, 'Изменения');
  });

  test('строка «Релиз:» в теле задаёт текст для релиза, «Релиз: -» скрывает коммит', () => {
    assert.equal(classify(commit('feat: add hotkey', 'Релиз: Горячая клавиша Alt+Shift+D')).text, 'Горячая клавиша Alt+Shift+D');
    assert.equal(classify(commit('feat: add hotkey', 'Release-note: Горячая клавиша')).text, 'Горячая клавиша');
    assert.equal(classify(commit('chore: bump jsdom', 'Релиз: -')), null);
  });

  test('entries: без коммитов бота, поднятия версии, скрытых и повторов', () => {
    const list = entries([
      commit('feat: добавить экспорт'),
      commit('feat: добавить экспорт'),
      commit('Обновить плашки в README [skip ci]', '', { author: 'github-actions[bot]' }),
      commit('chore: bump', 'Релиз: -'),
      commit('Поднять версию до 1.1.0'),
      commit('chore: версия 1.1.0'),
      commit('chore(release): bump version to 1.1.0'),
      commit('fix: исправить падение'),
    ]);
    assert.deepEqual(list.map((e) => e.text), ['Добавили экспорт', 'Исправили падение']);
    assert.equal(list[0].hash, HASH);
  });
});

describe('версии', () => {
  test('previousTag: старший релизный тег младше текущей версии', () => {
    assert.equal(previousTag(['v1.0.0', 'v1.2.0', 'v1.10.0', 'v2.0.0', 'v1.11.0-rc.1', 'nightly'], '1.11.0'), 'v1.10.0');
    assert.equal(previousTag(['v1.0.0', 'v1.1.0'], '1.1.0'), 'v1.0.0');
    assert.equal(previousTag([], '1.0.0'), null);
    assert.equal(previousTag(['v2.0.0'], '1.0.0'), null);
  });

  test('plural: русские склонения', () => {
    const forms = ['исправление', 'исправления', 'исправлений'];
    assert.equal(plural(1, forms), '1 исправление');
    assert.equal(plural(3, forms), '3 исправления');
    assert.equal(plural(5, forms), '5 исправлений');
    assert.equal(plural(11, forms), '11 исправлений');
    assert.equal(plural(12, forms), '12 исправлений');
    assert.equal(plural(21, forms), '21 исправление');
    assert.equal(plural(24, forms), '24 исправления');
  });
});

describe('CHANGELOG.md', () => {
  const items = entries([
    commit('feat: добавить экспорт', '', { date: '2026-10-14' }),
    commit('fix: исправить падение', '', { date: '2026-10-16' }),
    commit('test: покрыть экспорт', '', { date: '2026-10-15' }),
  ]);

  test('раздел: заголовок с датой последнего коммита, группы и ссылки на коммиты', () => {
    const section = renderSection('1.1.0', items, { repo: REPO });
    assert.equal(
      section,
      `## [1.1.0] — 2026-10-16

### Новое

- Добавили экспорт ([0123456](https://github.com/o/r/commit/${HASH}))

### Исправления

- Исправили падение ([0123456](https://github.com/o/r/commit/${HASH}))

### Тесты

- Покрыть экспорт ([0123456](https://github.com/o/r/commit/${HASH}))
`,
    );
    assert.match(renderSection('1.1.0', items), /\(0123456\)$/m);
    assert.equal(renderSection('1.1.0', []), null);
  });

  test('prependSection: новый файл, новая версия сверху, повторная сборка заменяет свой раздел', () => {
    const v1 = '## [1.0.0] — 2026-10-01\n\n### Изменения\n\n- Первая версия\n';
    const created = prependSection('', '1.0.0', v1);
    assert.ok(created.startsWith(HEADER.trimEnd()));
    assert.ok(created.endsWith(v1));

    const v2 = '## [1.1.0] — 2026-10-16\n\n### Новое\n\n- Экспорт\n';
    const withV2 = prependSection(created, '1.1.0', v2);
    assert.ok(withV2.indexOf('## [1.1.0]') < withV2.indexOf('## [1.0.0]'));
    assert.ok(withV2.includes(`${v2}\n${v1}`));

    const v2b = '## [1.1.0] — 2026-10-17\n\n### Новое\n\n- Экспорт\n- Тёмная тема\n';
    const replaced = prependSection(withV2, '1.1.0', v2b);
    assert.equal(replaced.match(/## \[1\.1\.0\]/g).length, 1);
    assert.ok(replaced.includes('- Тёмная тема\n\n## [1.0.0]'));
    assert.equal(prependSection(replaced, '1.1.0', v2b), replaced);
  });
});

describe('черновик релиза', () => {
  test('коротко и по-русски: сводка, группы без хэшей, внутренние изменения одной строкой', () => {
    const items = entries([
      commit('feat(popup): добавить экспорт отчёта в PDF'),
      commit('Добавить тёмную тему'),
      commit('fix: исправить падение попапа'),
      commit('refactor: вынести store в lib'),
      commit('ci: кешировать npm'),
    ]);
    assert.equal(
      releaseNotes(items, { repo: REPO, prevTag: 'v1.0.0', version: '1.1.0' }),
      `Коротко: 2 новые возможности и 1 исправление.

### Новое

- Добавили экспорт отчёта в PDF
- Добавили тёмную тему

### Исправления

- Исправили падение попапа

Также внутренние изменения (рефакторинг и служебные задачи) — на работу расширения не влияют.

**Полный список изменений:** https://github.com/o/r/compare/v1.0.0...v1.1.0
`,
    );
  });

  test('ломающие изменения идут первыми с предупреждением; только внутренние — отдельная фраза', () => {
    const breaking = releaseNotes(entries([commit('feat: добавить экспорт'), commit('feat!: изменить формат review.json')]), { version: '2.0.0' });
    assert.ok(breaking.startsWith('Коротко: 1 ломающее изменение и 1 новая возможность.'));
    assert.ok(breaking.indexOf('### Ломающие изменения\n\nПрочитайте перед обновлением.') < breaking.indexOf('### Новое'));
    assert.ok(!breaking.includes('Полный список'));

    const internal = releaseNotes(entries([commit('test: покрыть store')]), { repo: REPO, version: '1.0.1' });
    assert.ok(internal.startsWith('Только внутренние изменения (тесты) — на работу расширения не влияют.'));
    assert.ok(internal.includes('https://github.com/o/r/commits/v1.0.1'));
  });

  test('notRussian находит пункты без кириллицы', () => {
    const items = entries([commit('Initial commit'), commit('feat: добавить экспорт')]);
    assert.deepEqual(notRussian(items).map((e) => e.text), ['Initial commit']);
  });
});

// Фейковый GitHub API: GET /releases отдаёт список, POST/PATCH запоминаются.
function fakeGitHub(releases) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url, body: opts.body && JSON.parse(opts.body), auth: opts.headers?.Authorization });
    const body = method === 'GET' ? releases : { html_url: `https://github.com/o/r/releases/${method}` };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { calls, fetchImpl };
}

describe('GitHub Releases', () => {
  const opts = (gh) => ({ tag: 'v1.1.0', notes: 'Коротко: …', target: 'develop', token: 't', fetchImpl: gh.fetchImpl });

  test('syncDraft создаёт черновик, если его нет', async () => {
    const gh = fakeGitHub([{ id: 1, tag_name: 'v1.0.0', draft: false }]);
    assert.equal((await syncDraft(REPO, opts(gh))).action, 'created');
    const post = gh.calls.at(-1);
    assert.equal(post.method, 'POST');
    assert.equal(post.url, 'https://api.github.com/repos/o/r/releases');
    assert.equal(post.auth, 'Bearer t');
    assert.deepEqual(post.body, { tag_name: 'v1.1.0', name: 'v1.1.0', body: 'Коротко: …', draft: true, prerelease: false, target_commitish: 'develop' });
  });

  test('syncDraft обновляет существующий черновик и не трогает опубликованный релиз', async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: 'v1.1.0', draft: true }]);
    assert.equal((await syncDraft(REPO, opts(gh))).action, 'updated');
    assert.equal(gh.calls.at(-1).method, 'PATCH');
    assert.equal(gh.calls.at(-1).url, 'https://api.github.com/repos/o/r/releases/7');

    const published = fakeGitHub([{ id: 7, tag_name: 'v1.1.0', draft: false, html_url: 'u' }]);
    assert.deepEqual(await syncDraft(REPO, opts(published)), { action: 'skipped', url: 'u' });
    assert.ok(published.calls.every((c) => c.method === 'GET'));
  });

  test('syncDraft с replaces переименовывает прежний черновик, а не создаёт второй', async () => {
    const gh = fakeGitHub([{ id: 9, tag_name: 'v1.0.1', draft: true }]);
    assert.equal((await syncDraft(REPO, { ...opts(gh), replaces: 'v1.0.1' })).action, 'updated');
    const patch = gh.calls.at(-1);
    assert.equal(patch.url, 'https://api.github.com/repos/o/r/releases/9');
    assert.equal(patch.body.tag_name, 'v1.1.0');
    assert.equal(patch.body.name, 'v1.1.0');

    const released = fakeGitHub([{ id: 9, tag_name: 'v1.0.1', draft: false }]);
    assert.equal((await syncDraft(REPO, { ...opts(released), replaces: 'v1.0.1' })).action, 'created', 'опубликованный релиз не переименовывается');
  });

  test('publishRelease публикует черновик как есть, тег — на merge-коммит', async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: 'v1.1.0', draft: true, body: 'текст, поправленный руками' }]);
    const res = await publishRelease(REPO, { ...opts(gh), target: 'abc123' });
    assert.equal(res.action, 'published');
    const patch = gh.calls.at(-1);
    assert.equal(patch.method, 'PATCH');
    assert.deepEqual(patch.body, { draft: false, target_commitish: 'abc123', make_latest: 'true' });
  });

  test('publishRelease без черновика создаёт релиз сразу, опубликованный не трогает', async () => {
    const gh = fakeGitHub([]);
    assert.equal((await publishRelease(REPO, { ...opts(gh), target: 'abc123' })).action, 'created');
    assert.equal(gh.calls.at(-1).body.draft, false);
    assert.equal(gh.calls.at(-1).body.body, 'Коротко: …');

    const published = fakeGitHub([{ id: 7, tag_name: 'v1.1.0', draft: false, html_url: 'u' }]);
    assert.equal((await publishRelease(REPO, opts(published))).action, 'skipped');
    await assert.rejects(publishRelease(REPO, { ...opts(fakeGitHub([])), notes: '' }), /нет черновика/);
  });

  test('без GITHUB_TOKEN — понятная ошибка', async () => {
    await assert.rejects(syncDraft(REPO, { ...opts(fakeGitHub([])), token: '' }), /GITHUB_TOKEN/);
  });
});

describe('нужен ли новый релиз', () => {
  test('релиз нужен только при правках файлов расширения', () => {
    assert.equal(touchesExtension(['README.md', 'tests/pages/popup.test.js', '.github/workflows/tests.yml', 'scripts/badges.js']), false);
    assert.equal(touchesExtension([]), false);
    assert.equal(touchesExtension(['README.md', 'popup/popup.js']), true);
    assert.equal(touchesExtension(['manifest.json']), true);
    assert.equal(touchesExtension(['icons/icon16.png']), true);
    assert.equal(touchesExtension(['libs/x.js', 'manifest.json.bak']), false, 'только точные пути и папки');
  });
});

describe('автоматическое поднятие версии', () => {
  const item = (group) => ({ group, text: 'x', hash: HASH, date: '2026-10-19' });

  test('уровень по пунктам релиза: ломающие → major, новое → minor, остальное → patch', () => {
    assert.equal(nextVersion('1.4.2', [item('Изменения'), item('Тесты')]), '1.4.3');
    assert.equal(nextVersion('1.4.2', [item('Исправления'), item('Новое')]), '1.5.0');
    assert.equal(nextVersion('1.4.2', [item('Новое'), item('Ломающие изменения')]), '2.0.0');
    assert.equal(nextVersion('1.0.0', []), '1.0.1');
  });

  test('manifest.json и package.json: меняется только верхнеуровневая version, форматирование сохраняется', () => {
    const manifest = '{\n  "manifest_version": 3,\n  "name": "X",\n  "version": "1.0.0",\n  "description": "version 1.0.0"\n}\n';
    assert.equal(withVersion(manifest, '1.1.0'), manifest.replace('"version": "1.0.0"', '"version": "1.1.0"'));
    assert.match(withVersion(manifest, '1.1.0'), /"description": "version 1\.0\.0"/);
  });

  test('package-lock.json: версия проекта в корне и в packages[""], зависимости не трогаются', () => {
    const lock = `${JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/a': { version: '1.0.0' } } }, null, 2)}\n`;
    const out = JSON.parse(withLockVersion(lock, '1.0.1'));
    assert.equal(out.version, '1.0.1');
    assert.equal(out.packages[''].version, '1.0.1');
    assert.equal(out.packages['node_modules/a'].version, '1.0.0');
    assert.ok(withLockVersion(lock, '1.0.1').endsWith('}\n'));
  });

  test('настоящие файлы проекта поднимаются без потерь', () => {
    for (const [file, update] of [['manifest.json', withVersion], ['package.json', withVersion], ['package-lock.json', withLockVersion]]) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const { version } = JSON.parse(text);
      const out = update(text, '9.9.9');
      assert.equal(JSON.parse(out).version, '9.9.9', file);
      assert.equal(update(out, version), text, `${file}: обратная замена возвращает исходный текст`);
    }
  });
});

describe('раздел CHANGELOG при повышении версии', () => {
  test('prependSection с replaces убирает раздел прежней версии', () => {
    const before = prependSection(prependSection('', '1.0.0', '## [1.0.0] — 2026-10-01\n\n- старое'), '1.0.1', '## [1.0.1] — 2026-10-19\n\n- патч');
    const after = prependSection(before, '1.1.0', '## [1.1.0] — 2026-10-20\n\n- новое', '1.0.1');
    assert.ok(after.startsWith(HEADER.trimEnd()));
    assert.ok(!after.includes('## [1.0.1]'));
    assert.ok(after.indexOf('## [1.1.0]') < after.indexOf('## [1.0.0]'));
  });
});
