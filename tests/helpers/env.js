// Общая подготовка окружения для модулей из lib/: глобальные chrome и indexedDB.
import { createChrome } from './chrome.js';
import { createIndexedDB } from './idb.js';

export function installEnv(options = {}) {
  const chrome = createChrome(options);
  const indexedDB = createIndexedDB();
  globalThis.chrome = chrome;
  globalThis.indexedDB = indexedDB;
  return { chrome, indexedDB };
}

// 1×1 PNG и JPEG в виде data URL.
export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const PNG_2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAKgAE/SfSPQAAAABJRU5ErkJggg==';
export const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let seq = 0;

// Вариант блока. group — название группы: в готовом ревью (makeReview) вариант ссылается на неё по groupId,
// а при сохранении через store.addIssue группа с этим названием создаётся сама (newGroupTitle).
export const groupIdFor = (title) => `g-${title}`;

export function makeIssue({ group = 'Кнопка удаления', ...overrides } = {}) {
  seq++;
  return {
    id: crypto.randomUUID(),
    createdAt: Date.UTC(2026, 9, 16, 10, 0, seq),
    groupId: groupIdFor(group),
    newGroupTitle: group,
    note: '',
    screenshot: PNG,
    screenshotSize: { width: 1, height: 1 },
    screenshotTruncated: false,
    screenshotNote: '',
    styles: null,
    page: { url: 'https://example.com/catalog?utm=1', title: 'Каталог' },
    element: { selector: 'main > .card', name: 'div.card', text: 'Текст', width: 320, height: 200, attributes: { class: 'card' } },
    viewport: { width: 1440, height: 900, dpr: 2 },
    ...overrides,
  };
}

export function makeGroup(title, overrides = {}) {
  return { id: groupIdFor(title), title, description: '', mockupUrl: '', createdAt: Date.UTC(2026, 9, 16, 9, 0, 0), ...overrides };
}

// groups не переданы — собираются из вариантов, в порядке первого появления.
export function makeReview({ issues = [], groups, ...overrides } = {}) {
  seq++;
  const titles = new Map(issues.map((i) => [i.groupId, i.newGroupTitle || i.groupId]));
  // Те же объекты, а не копии: тесты меняют вариант и записывают ревью заново.
  for (const i of issues) delete i.newGroupTitle;
  return {
    id: `review-${seq}`,
    title: 'Ревью страницы оплаты',
    author: 'Анна',
    devTicketUrl: 'https://tracker.example.com/DEV-1',
    designTicketUrl: 'https://tracker.example.com/DESIGN-2',
    createdAt: Date.UTC(2026, 9, 16, 9, 0, 0),
    updatedAt: Date.UTC(2026, 9, 16, 9, 30, 0),
    groups: groups || [...titles].filter(([id]) => id).map(([id, title]) => ({ ...makeGroup(title), id })),
    issues,
    ...overrides,
  };
}
