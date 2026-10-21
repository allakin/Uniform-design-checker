import { migrateLegacy } from './groups.js';

// Хранилище ревью в chrome.storage.local.
//   reviewIndex     — [{ id, title, author, createdAt, updatedAt, issueCount, groupCount }]
//   review:<id>     — полный объект ревью: группы блоков и варианты со скриншотами (см. lib/groups.js)
//   activeReviewId  — ревью, в которое попадают новые варианты

const KEY_INDEX = 'reviewIndex';
const KEY_ACTIVE = 'activeReviewId';
const reviewKey = (id) => `review:${id}`;

// Сериализуем записи внутри одного контекста, чтобы параллельные
// read-modify-write не затирали друг друга.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function uid() {
  return crypto.randomUUID();
}

export async function listReviews() {
  const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAllReviews() {
  const metas = await listReviews();
  return (await Promise.all(metas.map((m) => getReview(m.id)))).filter(Boolean);
}

export async function getReview(id) {
  if (!id) return null;
  const key = reviewKey(id);
  const { [key]: review } = await chrome.storage.local.get(key);
  return review || null;
}

// Текст для поиска в списке ревью: без скриншотов, чтобы не загружать ревью целиком.
function searchText(review) {
  return [
    review.title,
    review.author,
    review.devTicketUrl,
    review.designTicketUrl,
    ...(review.groups || []).map((g) => g.title),
    ...review.issues.flatMap((i) => [i.note, i.page?.title, i.page?.url]),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
    .slice(0, 4000);
}

function metaOf(review) {
  return {
    id: review.id,
    title: review.title,
    author: review.author || '',
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    issueCount: review.issues.length,
    groupCount: (review.groups || []).length,
    search: searchText(review),
  };
}

async function writeReview(review, { touch = true } = {}) {
  if (touch) review.updatedAt = Date.now();
  const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
  const meta = metaOf(review);
  const i = index.findIndex((r) => r.id === review.id);
  if (i >= 0) index[i] = meta;
  else index.push(meta);
  await chrome.storage.local.set({ [reviewKey(review.id)]: review, [KEY_INDEX]: index });
  return review;
}

// Ревью, созданные до появления поиска, дополняем поисковым текстом (дата изменения не трогается).
export function reindexIfNeeded() {
  return exclusive(async () => {
    const { [KEY_INDEX]: index = [] } = await chrome.storage.local.get(KEY_INDEX);
    const stale = index.filter((m) => m.search === undefined);
    if (!stale.length) return;
    for (const m of stale) {
      const review = await getReview(m.id);
      if (review) Object.assign(m, metaOf(review));
    }
    await chrome.storage.local.set({ [KEY_INDEX]: index });
  });
}

// Ревью прежнего формата (замечания без групп, например от Design Review Checker) переводятся в группы;
// дата изменения не трогается. Повторный вызов ничего не пишет.
export function migrateIfNeeded() {
  return exclusive(async () => {
    for (const meta of await listReviews()) {
      const review = await getReview(meta.id);
      if (!review) continue;
      const migrated = migrateLegacy(review, uid);
      if (migrated !== review) await writeReview(migrated, { touch: false });
    }
  });
}

export function createReview({ title, author = '', devTicketUrl = '', designTicketUrl = '' }) {
  return exclusive(async () => {
    const now = Date.now();
    const review = {
      id: uid(),
      title: title.trim() || 'Дизайн-ревью',
      author: author.trim(),
      devTicketUrl,
      designTicketUrl,
      createdAt: now,
      updatedAt: now,
      groups: [],
      issues: [],
    };
    await writeReview(review);
    await chrome.storage.local.set({ [KEY_ACTIVE]: review.id });
    return review;
  });
}

// Восстановление ревью из папки на диске (например, после переустановки расширения):
// сохраняется как есть, с исходными датами. Ревью с таким id уже есть — не трогаем, возвращаем false.
export function importReview(review) {
  return exclusive(async () => {
    if (await getReview(review.id)) return false;
    await writeReview(review, { touch: false });
    return true;
  });
}

export function updateReview(id, patch) {
  return exclusive(async () => {
    const review = await getReview(id);
    if (!review) throw new Error('Ревью не найдено');
    Object.assign(review, patch);
    return writeReview(review);
  });
}

export function deleteReview(id) {
  return exclusive(async () => {
    const { [KEY_INDEX]: index = [], [KEY_ACTIVE]: active } = await chrome.storage.local.get([KEY_INDEX, KEY_ACTIVE]);
    await chrome.storage.local.set({ [KEY_INDEX]: index.filter((r) => r.id !== id) });
    await chrome.storage.local.remove(reviewKey(id));
    if (active === id) await chrome.storage.local.remove(KEY_ACTIVE);
  });
}

export async function getActiveReviewId() {
  const { [KEY_ACTIVE]: id } = await chrome.storage.local.get(KEY_ACTIVE);
  return id || null;
}

export async function setActiveReviewId(id) {
  if (id) await chrome.storage.local.set({ [KEY_ACTIVE]: id });
  else await chrome.storage.local.remove(KEY_ACTIVE);
}

export async function getActiveReview() {
  const review = await getReview(await getActiveReviewId());
  return review;
}

// Текущее ревью, а если его нет (восстановили ревью из папки, удалили текущее) — последнее изменённое,
// которое и становится текущим. null — ревью нет совсем.
export async function activeOrLatestReview() {
  const active = await getActiveReview();
  if (active) return active;
  const [latest] = await listReviews();
  if (!latest) return null;
  await setActiveReviewId(latest.id);
  return getReview(latest.id);
}

// Новый вариант блока. issue.groupId — существующая группа, issue.newGroupTitle — создать группу с этим названием.
// Возвращает { issue, group, number: номер варианта в группе }.
export function addIssue(reviewId, { groupId, newGroupTitle, ...variant }) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) throw new Error('Ревью не найдено — создайте новое в окне расширения');
    review.groups ||= [];
    const now = Date.now();
    let group = review.groups.find((g) => g.id === groupId);
    if (!group) {
      const title = String(newGroupTitle || '').trim();
      if (!title) throw new Error(groupId ? 'Группа не найдена — её удалили, выберите другую' : 'Укажите группу');
      group = review.groups.find((g) => g.title === title) || newGroup(review, title, now);
    }
    const full = { id: uid(), createdAt: now, note: '', ...variant, groupId: group.id };
    review.issues.push(full);
    await writeReview(review);
    return { issue: full, group, number: review.issues.filter((i) => i.groupId === group.id).length };
  });
}

function newGroup(review, title, now = Date.now()) {
  const group = { id: uid(), title, description: '', mockupUrl: '', createdAt: now };
  review.groups.push(group);
  return group;
}

export function addGroup(reviewId, title) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) throw new Error('Ревью не найдено');
    review.groups ||= [];
    const group = newGroup(review, String(title || '').trim() || 'Новая группа');
    await writeReview(review);
    return group;
  });
}

export function updateGroup(reviewId, groupId, patch) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    const group = review?.groups?.find((g) => g.id === groupId);
    if (!group) throw new Error('Группа не найдена');
    Object.assign(group, patch, { updatedAt: Date.now() });
    await writeReview(review);
    return group;
  });
}

// Удаляет группу вместе с её вариантами.
export function deleteGroup(reviewId, groupId) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) return;
    review.groups = (review.groups || []).filter((g) => g.id !== groupId);
    review.issues = review.issues.filter((i) => i.groupId !== groupId);
    await writeReview(review);
  });
}

export function moveGroup(reviewId, groupId, delta) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    const groups = review?.groups || [];
    const from = groups.findIndex((g) => g.id === groupId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= groups.length) return;
    const [item] = groups.splice(from, 1);
    groups.splice(to, 0, item);
    await writeReview(review);
  });
}

// Переносит вариант в другую группу (newGroupTitle — в новую). Вариант встаёт в конец группы.
export function moveIssueToGroup(reviewId, issueId, { groupId, newGroupTitle }) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    const k = review?.issues.findIndex((x) => x.id === issueId) ?? -1;
    if (k < 0) throw new Error('Вариант не найден');
    review.groups ||= [];
    let group = review.groups.find((g) => g.id === groupId);
    if (!group) {
      const title = String(newGroupTitle || '').trim();
      if (!title) throw new Error('Группа не найдена');
      group = review.groups.find((g) => g.title === title) || newGroup(review, title);
    }
    const [issue] = review.issues.splice(k, 1);
    Object.assign(issue, { groupId: group.id, updatedAt: Date.now() });
    review.issues.push(issue);
    await writeReview(review);
    return group;
  });
}

export function updateIssue(reviewId, issueId, patch) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    const issue = review?.issues.find((x) => x.id === issueId);
    if (!issue) throw new Error('Вариант не найден');
    Object.assign(issue, patch, { updatedAt: Date.now() });
    await writeReview(review);
    return issue;
  });
}

export function deleteIssue(reviewId, issueId) {
  return exclusive(async () => {
    const review = await getReview(reviewId);
    if (!review) return;
    review.issues = review.issues.filter((x) => x.id !== issueId);
    await writeReview(review);
  });
}

export function onReviewsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === KEY_INDEX || k === KEY_ACTIVE || k.startsWith('review:'))) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
