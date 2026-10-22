// Собирает раздел CHANGELOG.md для версии из manifest.json по коммитам с последнего тега-релиза
// и вставляет его в начало файла (раздел этой версии, если уже есть, заменяется — повторный запуск ничего не дублирует).
// С --draft по тем же коммитам собирается черновик релиза v<версия> на GitHub — коротко и по-русски:
// сводка, заметные изменения по группам, внутренние — одной строкой. Черновик создаётся или обновляется
// с целевой веткой main, опубликованный релиз не трогается.
// С --bump (вместе с --draft, в CI): если текущая версия уже выпущена, а с неё менялись файлы расширения,
// версия в manifest.json, package.json и package-lock.json поднимается сама — по коммитам (см. nextVersion).
// С --publish черновик публикуется как есть (с ручными правками), тег ставится на TARGET_SHA или HEAD;
// CHANGELOG.md при этом не меняется — раздел уже пришёл из develop.
// Для --draft и --publish нужен GITHUB_TOKEN с правом contents: write.
// Запуск: npm run changelog-prepend [-- --draft [--bump] | --publish] [--notes <файл>] [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repoSlug, parseVersion, compareVersions, fetchReleases, DEFAULT_BRANCH } from './badges.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHANGELOG = `${ROOT}CHANGELOG.md`;

export const HEADER = `# Changelog

Все заметные изменения расширения. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).
Разделы собирает \`npm run changelog-prepend\` из сообщений коммитов; после сборки их можно поправить руками.
`;

// Группы в порядке вывода. Типы — из Conventional Commits; коммиты без префикса попадают в «Изменения».
// technical — внутренние изменения: в CHANGELOG перечисляются, в черновике релиза сворачиваются в одну строку.
// forms — склонения для строки «Коротко: …» в черновике.
export const GROUPS = [
  { title: 'Ломающие изменения', types: [], forms: ['ломающее изменение', 'ломающих изменения', 'ломающих изменений'] },
  { title: 'Новое', types: ['feat'], forms: ['новая возможность', 'новые возможности', 'новых возможностей'] },
  { title: 'Исправления', types: ['fix'], forms: ['исправление', 'исправления', 'исправлений'] },
  { title: 'Улучшения', types: ['perf'], forms: ['улучшение', 'улучшения', 'улучшений'] },
  { title: 'Изменения', types: [], forms: ['изменение', 'изменения', 'изменений'] },
  { title: 'Рефакторинг', types: ['refactor'], technical: 'рефакторинг' },
  { title: 'Документация', types: ['docs'], technical: 'документация' },
  { title: 'Тесты', types: ['test'], technical: 'тесты' },
  { title: 'Служебное', types: ['build', 'ci', 'chore', 'style'], technical: 'служебные задачи' },
];

// Коммиты бота (плашки README, сам CHANGELOG) в раздел не попадают.
const BOT_AUTHORS = ['github-actions[bot]'];
// Коммиты, которые только поднимают версию («Поднять версию до 1.1.0», «chore: bump version to 1.1.0»), — тоже.
const VERSION_BUMP = /^(?:\w+(?:\([^)]*\))?!?:\s*)?(?:поднять|повысить|обновить|bump)?\s*(?:верси[юяи]|version|release|релиз)(?![А-Яа-яЁёA-Za-z]).*\d+\.\d+\.\d+/i;

// Файлы самого расширения. Новый релиз нужен, только если менялись они; тесты, CI, скрипты и документация — не повод.
export const EXTENSION_PATHS = ['manifest.json', 'background.js', 'content/', 'lib/', 'popup/', 'pages/', 'icons/'];
export const touchesExtension = (files) => files.some((f) => EXTENSION_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));

// Следующая версия по пунктам релиза: ломающие изменения → major, новое → minor, остальное → patch.
export function nextVersion(version, items) {
  const [major, minor, patch] = parseVersion(version).parts;
  if (items.some((e) => e.group === 'Ломающие изменения')) return `${major + 1}.0.0`;
  if (items.some((e) => e.group === 'Новое')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Новая версия в manifest.json / package.json: меняется только верхнеуровневое поле, остальной текст файла — как был.
export function withVersion(text, version) {
  const from = JSON.parse(text).version;
  const out = text.replace(`"version": "${from}"`, `"version": "${version}"`);
  if (JSON.parse(out).version !== version) throw new Error(`не удалось заменить version ${from} → ${version}`);
  return out;
}

// package-lock.json: версия проекта стоит в корне и в packages[""]; версии зависимостей не трогаются.
export function withLockVersion(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

const VERSION_FILES = { 'manifest.json': withVersion, 'package.json': withVersion, 'package-lock.json': withLockVersion };
const writeVersion = (version) => {
  for (const [file, update] of Object.entries(VERSION_FILES)) writeFileSync(`${ROOT}${file}`, update(readFileSync(`${ROOT}${file}`, 'utf8'), version));
};

// В GitHub Actions заметка видна в сводке прогона, локально — обычная строка.
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const SEP = '\x1f';
const END = '\x1e';
export const LOG_FORMAT = `%H${SEP}%an${SEP}%cs${SEP}%s${SEP}%b${END}`;

export function parseLog(log) {
  return log
    .split(END)
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, author, date, subject, body = ''] = rec.split(SEP);
      return { hash, author, date, subject: subject.trim(), body: body.trim() };
    });
}

// Сообщения коммитов обычно в инфинитиве («Добавить тёмную тему»). В релизе читается «Добавили тёмную тему»:
// прошедшее время сохраняет падеж дополнения, поэтому фраза остаётся грамотной. Формы вроде «Добавлена …»
// уже звучат как надо и не меняются. Для коммитов без префикса feat/fix глагол заодно подсказывает группу.
const VERB_FORMS = [
  [{ добавить: 'Добавили' }, ['добавлен', 'добавлена', 'добавлено', 'добавлены'], 'Новое'],
  [{ исправить: 'Исправили', починить: 'Исправили', поправить: 'Поправили' }, ['исправлен', 'исправлена', 'исправлено', 'исправлены'], 'Исправления'],
  [{ улучшить: 'Улучшили' }, ['улучшен', 'улучшена', 'улучшено', 'улучшены'], 'Улучшения'],
  [{ ускорить: 'Ускорили' }, ['ускорен', 'ускорена', 'ускорено', 'ускорены'], 'Улучшения'],
  [{ обновить: 'Обновили', изменить: 'Изменили', переименовать: 'Переименовали', перенести: 'Перенесли', удалить: 'Удалили', убрать: 'Убрали' }, ['обновлен', 'обновлён', 'обновлена', 'обновлено', 'обновлены'], 'Изменения'],
];
const VERBS = new Map(
  VERB_FORMS.flatMap(([infinitives, participles, group]) => [
    ...Object.entries(infinitives).map(([w, past]) => [w, { past, group }]),
    ...participles.map((w) => [w, { past: null, group }]),
  ]),
);

const leadingVerb = (text) => VERBS.get(text.trim().match(/^[А-Яа-яЁё]+/)?.[0].toLowerCase());

const MAX_ITEM = 120;

// Короткая понятная строка для релиза: первое предложение, без точки в конце, «Добавить …» → «Добавили …».
export function humanize(text) {
  let t = text.trim().replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].replace(/[.;:,\s]+$/, '');
  const m = t.match(/^([А-Яа-яЁё]+)\s+(.+)$/);
  const past = m && VERBS.get(m[1].toLowerCase())?.past;
  if (past) t = `${past} ${m[2]}`;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > MAX_ITEM ? `${t.slice(0, MAX_ITEM - 1).trimEnd()}…` : t;
}

// Строка «Релиз: …» (или «Release-note: …») в теле коммита задаёт текст для релиза; «Релиз: -» скрывает коммит.
const NOTE_TRAILER = /^(?:Релиз|Release-note):[ \t]*(.*)$/im;

// «feat(popup)!: текст» → { group, text }. Без префикса группа берётся по глаголу («Исправить …» → «Исправления»),
// иначе — «Изменения». null — коммит скрыт из релиза.
export function classify({ subject, body = '' }) {
  const note = body.match(NOTE_TRAILER)?.[1].trim();
  if (note === '-') return null;
  const m = subject.match(/^(\w+)(?:\([^)]+\))?(!)?:\s*(.+)$/);
  const text = humanize(note || (m ? m[3] : subject));
  if (!m) return { group: leadingVerb(subject)?.group ?? 'Изменения', text };
  const [, type, bang] = m;
  if (bang || /^BREAKING[ -]CHANGE:/m.test(body)) return { group: 'Ломающие изменения', text };
  const group = GROUPS.find((g) => g.types.includes(type.toLowerCase()));
  return { group: group?.title ?? 'Изменения', text };
}

// Пункты релиза из коммитов: без коммитов бота, поднятия версии и скрытых; одинаковые тексты схлопываются.
export function entries(commits) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    if (BOT_AUTHORS.includes(c.author) || VERSION_BUMP.test(c.subject)) continue;
    const e = classify(c);
    if (!e || seen.has(`${e.group}\n${e.text}`)) continue;
    seen.add(`${e.group}\n${e.text}`);
    out.push({ ...e, hash: c.hash, date: c.date });
  }
  return out;
}

// Старший тег-релиз (vX.Y.Z), который младше текущей версии. Нет такого — null (берётся вся история).
export function previousTag(tags, version) {
  const current = parseVersion(version);
  let best = null;
  for (const tag of tags) {
    const v = parseVersion(tag);
    if (!v || v.pre || compareVersions(v, current) >= 0) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { tag: tag.trim(), v };
  }
  return best?.tag ?? null;
}

const grouped = (items) => GROUPS.map((g) => ({ ...g, items: items.filter((e) => e.group === g.title) })).filter((g) => g.items.length);

// Раздел «## [1.2.0] — 2026-10-16» для CHANGELOG.md: все группы, у пунктов — ссылки на коммиты.
// Дата — дата последнего коммита в разделе, чтобы повторная сборка не меняла файл.
export function renderSection(version, items, { repo = null } = {}) {
  if (!items.length) return null;
  const link = (hash) => (repo ? `[${hash.slice(0, 7)}](https://github.com/${repo}/commit/${hash})` : hash.slice(0, 7));
  const date = items.map((e) => e.date).sort().at(-1);
  const parts = [`## [${version}] — ${date}`];
  for (const g of grouped(items)) parts.push(`### ${g.title}\n\n${g.items.map((e) => `- ${e.text} (${link(e.hash)})`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}

// 1 возможность, 2 возможности, 5 возможностей.
export function plural(n, [one, few, many]) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return `${n} ${one}`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const joinRu = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} и ${list.at(-1)}` : list[0]);

// Текст черновика релиза на GitHub: строка «Коротко», заметные для пользователя изменения по группам
// без хэшей, внутренние изменения — одной строкой, в конце ссылка на полный diff.
export function releaseNotes(items, { repo = null, prevTag = null, version } = {}) {
  const groups = grouped(items);
  const visible = groups.filter((g) => !g.technical);
  const technical = groups.filter((g) => g.technical);
  const parts = [];
  if (visible.length) parts.push(`Коротко: ${joinRu(visible.map((g) => plural(g.items.length, g.forms)))}.`);
  for (const g of visible) {
    const hint = g.title === 'Ломающие изменения' ? 'Прочитайте перед обновлением.\n\n' : '';
    parts.push(`### ${g.title}\n\n${hint}${g.items.map((e) => `- ${e.text}`).join('\n')}`);
  }
  if (technical.length) {
    const what = joinRu(technical.map((g) => g.technical));
    parts.push(visible.length ? `Также внутренние изменения (${what}) — на работу расширения не влияют.` : `Только внутренние изменения (${what}) — на работу расширения не влияют.`);
  }
  if (repo) {
    const full = prevTag ? `https://github.com/${repo}/compare/${prevTag}...v${version}` : `https://github.com/${repo}/commits/v${version}`;
    parts.push(`**Полный список изменений:** ${full}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// Пункты без русского текста: их стоит переписать в черновике или задать строкой «Релиз: …» в коммите.
export const notRussian = (items) => items.filter((e) => !/[А-Яа-яЁё]/.test(e.text));

// Вставляет раздел в начало списка версий. Раздел этой версии уже есть — заменяет его на месте.
// replaces — версия, раздел которой заменяется новым (бот поднял 1.0.1 до 1.1.0: раздела 1.0.1 больше нет).
export function prependSection(changelog, version, section, replaces = null) {
  const chunks = (changelog?.trim() ? changelog : HEADER).split(/^(?=## \[)/m).filter((c) => !(replaces && c.startsWith(`## [${replaces}]`)));
  const head = chunks[0]?.startsWith('## [') ? '' : chunks.shift();
  const own = chunks.findIndex((c) => c.startsWith(`## [${version}]`));
  if (own >= 0) chunks[own] = section;
  else chunks.unshift(section);
  return `${[head, ...chunks].filter(Boolean).map((c) => c.trimEnd()).join('\n\n')}\n`;
}

async function api(repo, path, { method = 'GET', body, token, fetchImpl }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
  return res.json();
}

async function findRelease(repo, tag, { token, fetchImpl }) {
  if (!token) throw new Error('для --draft и --publish нужен GITHUB_TOKEN');
  return (await fetchReleases(repo, { token, fetchImpl })).find((r) => r.tag_name === tag) ?? null;
}

// Создаёт или обновляет черновик релиза tag на GitHub. Опубликованный релиз с этим тегом не трогает.
// replaces — тег прежнего черновика (бот поднял версию дальше): он переименовывается в tag, а не остаётся рядом.
export async function syncDraft(repo, { tag, notes, target, replaces = null, token = process.env.GITHUB_TOKEN, fetchImpl = fetch }) {
  const existing = (await findRelease(repo, tag, { token, fetchImpl })) ?? (replaces ? await findRelease(repo, replaces, { token, fetchImpl }).then((r) => (r?.draft ? r : null)) : null);
  if (existing && !existing.draft) return { action: 'skipped', url: existing.html_url };
  const body = { tag_name: tag, name: tag, body: notes, draft: true, prerelease: false };
  if (target) body.target_commitish = target;
  const release = await api(repo, `/releases${existing ? `/${existing.id}` : ''}`, { method: existing ? 'PATCH' : 'POST', body, token, fetchImpl });
  return { action: existing ? 'updated' : 'created', url: release.html_url };
}

// Публикует релиз tag: черновик — как есть (ручные правки в нём сохраняются), без черновика — с notes.
// Тег создаётся на target. Уже опубликованный релиз не трогает.
export async function publishRelease(repo, { tag, notes, target, token = process.env.GITHUB_TOKEN, fetchImpl = fetch }) {
  const existing = await findRelease(repo, tag, { token, fetchImpl });
  if (existing && !existing.draft) return { action: 'skipped', url: existing.html_url };
  if (!existing && !notes) throw new Error(`нет черновика ${tag} и нечего в него положить`);
  const body = existing
    ? { draft: false, target_commitish: target, make_latest: 'true' }
    : { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false, target_commitish: target, make_latest: 'true' };
  const release = await api(repo, `/releases${existing ? `/${existing.id}` : ''}`, { method: existing ? 'PATCH' : 'POST', body, token, fetchImpl });
  return { action: existing ? 'published' : 'created', url: release.html_url };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function option(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : (process.argv[i + 1] ?? '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const draft = process.argv.includes('--draft');
  const publish = process.argv.includes('--publish');
  const dryRun = process.argv.includes('--dry-run');
  const notesFile = option('--notes');
  const bump = process.argv.includes('--bump');
  let { version } = JSON.parse(readFileSync(`${ROOT}manifest.json`, 'utf8'));
  let tag = `v${version}`;
  const repo = repoSlug();
  if ((draft || publish) && !repo) throw new Error('не удалось определить репозиторий GitHub (GITHUB_REPOSITORY или origin)');
  // Все теги, а не только --merged: тег релиза стоит на merge-коммите в main, из develop его не видно.
  const tags = git('tag', '--list').split('\n').filter(Boolean);
  const log = (range) => entries(parseLog(git('log', '--no-merges', `--format=${LOG_FORMAT}`, ...range)));

  // Тег текущей версии уже есть — версия выпущена, новые коммиты относятся к следующей.
  if (tags.includes(tag)) {
    const pendingItems = log([`${tag}..HEAD`]);
    const pending = pendingItems.length;
    const extensionChanged = touchesExtension(git('diff', '--name-only', tag, 'HEAD').split('\n').filter(Boolean));
    const msg = `${tag} уже выпущена. Поднимите version в manifest.json и package.json, чтобы собрать следующий релиз.`;
    const unchanged = `${tag} уже выпущена, а с неё не менялись файлы расширения (${EXTENSION_PATHS.join(', ')}) — новый релиз не нужен.`;
    if (draft && bump && pending && extensionChanged) {
      // Расширение изменилось — сразу готовим следующую версию: черновик и раздел CHANGELOG собираются уже для неё.
      const next = nextVersion(version, pendingItems);
      if (!dryRun) writeVersion(next);
      notice(`${tag} уже выпущена, а расширение с неё менялось — версия поднята до ${next} (${Object.keys(VERSION_FILES).join(', ')}).`);
      version = next;
      tag = `v${next}`;
    } else if (draft || (publish && !pending)) {
      // Черновик в develop сразу после релиза или перезапуск публикации без новых коммитов — обычное состояние.
      notice(pending && !extensionChanged ? unchanged : msg);
      process.exit(0);
    } else if (publish && !extensionChanged) {
      // В main пришли только тесты, CI или документация — расширение то же, выпускать нечего.
      notice(unchanged);
      process.exit(0);
    } else {
      console.error(publish ? `${msg} В main пришли ${plural(pending, ['новый коммит', 'новых коммита', 'новых коммитов'])} — релиз не опубликован.` : msg);
      process.exit(1);
    }
  }

  const prevTag = previousTag(tags, version);
  const items = log(prevTag ? [`${prevTag}..HEAD`] : []);
  // Версия ещё не выпущена, а коммиты требуют уровня выше (бот поднял до 1.0.1, потом пришло «Новое» → 1.1.0).
  // Понижать версию бот не будет: поднятая руками выше нужного остаётся как есть.
  let replaces = null;
  if (draft && bump && prevTag) {
    const wanted = nextVersion(prevTag, items);
    if (compareVersions(parseVersion(wanted), parseVersion(version)) > 0) {
      if (!dryRun) writeVersion(wanted);
      notice(`С ${prevTag} пришли изменения уровнем выше ${version} — версия поднята до ${wanted}; черновик ${tag} и его раздел в CHANGELOG.md заменены.`);
      replaces = version;
      version = wanted;
      tag = `v${wanted}`;
    }
  }
  const section = renderSection(version, items, { repo });
  if (!section && !publish) {
    console.log(`С ${prevTag ?? 'начала истории'} нет коммитов для ${tag} — CHANGELOG.md не изменён.`);
    process.exit(0);
  }
  for (const e of notRussian(items)) {
    console.warn(`⚠ Пункт без русского текста: «${e.text}» (${e.hash.slice(0, 7)}) — поправьте черновик или добавьте в коммит строку «Релиз: …».`);
  }

  const notes = section ? releaseNotes(items, { repo, prevTag, version }) : '';
  if (notesFile) writeFileSync(notesFile, notes);

  if (publish) {
    const target = process.env.TARGET_SHA || git('rev-parse', 'HEAD').trim();
    if (dryRun) {
      console.log(`Будет опубликован ${tag} на ${target.slice(0, 7)}. Текст, если черновика нет:\n\n${notes}`);
      process.exit(0);
    }
    const { action, url } = await publishRelease(repo, { tag, notes, target });
    const verb = { published: 'опубликован из черновика', created: 'опубликован (черновика не было)', skipped: 'уже опубликован — не трогаю' }[action];
    console.log(`Релиз ${tag} ${verb}: ${url}`);
    process.exit(0);
  }

  const before = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '';
  const after = prependSection(before, version, section, replaces);
  if (dryRun) {
    console.log(`${section}\n--- Черновик релиза ${tag} ---\n\n${notes}`);
  } else if (after !== before) {
    writeFileSync(CHANGELOG, after);
    console.log(`CHANGELOG.md: раздел ${tag} собран: ${plural(items.length, ['пункт', 'пункта', 'пунктов'])} с ${prevTag ?? 'начала истории'}.`);
  } else {
    console.log(`CHANGELOG.md: раздел ${tag} уже актуален.`);
  }

  if (draft && !dryRun) {
    // Черновик целится в main: релиз выходит туда, тег при публикации ставится на merge-коммит в main.
    const { action, url } = await syncDraft(repo, { tag, notes, target: DEFAULT_BRANCH, replaces: replaces && `v${replaces}` });
    const verb = { created: 'создан', updated: 'обновлён', skipped: 'уже опубликован — не трогаю' }[action];
    console.log(`Черновик релиза ${tag} ${verb}: ${url}`);
  }
}
