// In-memory мок API chrome.* — ровно то, чем пользуется расширение.
// chrome.storage.local хранит структурные копии (как настоящий браузер) и шлёт onChanged.
import { mock } from 'node:test';

export function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    dispatch: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function createStorageArea(areaName, onChanged, initial = {}) {
  const data = new Map(Object.entries(clone(initial)));
  const emit = (changes) => {
    if (Object.keys(changes).length) onChanged.dispatch(changes, areaName);
  };
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : def;
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) };
        data.set(k, clone(v));
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      emit(changes);
    },
    async clear() {
      await this.remove([...data.keys()]);
    },
  };
}

export const EXTENSION_ID = 'test-extension-id';

export function createChrome({ storage = {}, tabs = [] } = {}) {
  const onChanged = createEvent();
  const tabList = tabs.map((t, i) => ({ id: i + 1, windowId: 1, active: i === 0, ...t }));
  let nextTabId = tabList.length + 1;

  const chrome = {
    storage: {
      onChanged,
      local: createStorageArea('local', onChanged, storage),
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\//, '')}`,
      onMessage: createEvent(),
      sendMessage: mock.fn(async () => ({ ok: true })),
    },
    tabs: {
      list: tabList,
      get: mock.fn(async (id) => {
        const tab = tabList.find((t) => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      }),
      query: mock.fn(async (q = {}) =>
        tabList.filter((t) => (q.active === undefined || t.active === q.active) && (q.url === undefined || t.url === q.url)),
      ),
      create: mock.fn(async ({ url, active = true }) => {
        const tab = { id: nextTabId++, windowId: 1, url, active };
        tabList.push(tab);
        return tab;
      }),
      update: mock.fn(async (id, props) => Object.assign(tabList.find((t) => t.id === id) || {}, props)),
      remove: mock.fn(async () => {}),
      getCurrent: mock.fn(async () => tabList[0]),
      sendMessage: mock.fn(async () => undefined),
      captureVisibleTab: mock.fn(async () => 'data:image/png;base64,iVBORw0KGgo='),
    },
    windows: {
      update: mock.fn(async () => ({})),
    },
    scripting: {
      executeScript: mock.fn(async () => [{ result: undefined }]),
    },
    commands: {
      getAll: mock.fn(async () => [{ name: 'start-pick', shortcut: '⌥⇧D', description: '' }]),
      onCommand: createEvent(),
    },
  };
  return chrome;
}

// Ждём, пока отработают все уже запланированные промисы/таймеры с нулевой задержкой.
export const flush = () => new Promise((r) => setTimeout(r, 0));
