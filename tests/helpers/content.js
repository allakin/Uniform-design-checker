// Загружает content/icons.js + content/content.js в jsdom-страницу с моком chrome.*.
// content.js — IIFE без экспортов, поэтому для тестов перед финальным `})();` дописываем
// экспорт внутренних функций в globalThis.__udcTest. Сам файл расширения не меняется.
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createChrome } from './chrome.js';
import { PNG } from './env.js';

const ROOT = new URL('../../', import.meta.url);
export const CONTENT_SRC = readFileSync(new URL('content/content.js', ROOT), 'utf8');
export const ICONS_SRC = readFileSync(new URL('content/icons.js', ROOT), 'utf8');

const EXPORTS = [
  'state', 'parseColor', 'hex', 'hexify', 'clip', 'shorthand', 'blend', 'luminance',
  'effectiveBackground', 'textHost', 'contrastInfo', 'collectStyles', 'parseDeclarations', 'matchedDeclarations',
  'collectVariables', 'attributesOf', 'isDropdownSelect', 'openSelectList', 'cssPath', 'elementInfo', 'describe',
  'esc', 'unionRect', 'dragRect', 'arrow',
  'startPicking', 'select', 'save', 'reset', 'showToast', 'pickGroup',
];

export function instrumentedContentSource() {
  const end = CONTENT_SRC.lastIndexOf('})();');
  if (end < 0) throw new Error('content.js больше не заканчивается на `})();` — обновите tests/helpers/content.js');
  const hook = `globalThis.__udcTest = { ${EXPORTS.join(', ')}, ui: () => ui, host: () => host };\n`;
  return CONTENT_SRC.slice(0, end) + hook + CONTENT_SRC.slice(end);
}

// Все созданные окна закрываем после тестов: иначе rAF-цикл подсветки и таймеры держат процесс.
const opened = new Set();
export function closeAllContent() {
  for (const w of opened) {
    try {
      w.__udcInstance?.destroy();
    } catch {}
    w.close();
  }
  opened.clear();
}

export function loadContent({ html = '<main><h1>Каталог</h1><button id="buy" class="btn primary">Купить</button></main>', url = 'https://shop.example.com/catalog?x=1', title = 'Каталог', media = () => true, inject = true } = {}) {
  const virtualConsole = new VirtualConsole(); // глушим «Not implemented: window.scrollTo» и т.п.
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;
  opened.add(window);

  // --- то, чего нет в jsdom ---
  window.matchMedia = (q) => ({ matches: media(q), media: q });
  if (!('styleSheets' in window.ShadowRoot.prototype)) {
    Object.defineProperty(window.ShadowRoot.prototype, 'styleSheets', {
      get() {
        return [...this.querySelectorAll('style')].map((st) => st.sheet).filter(Boolean);
      },
    });
  }
  window.scrollTo = window.scrollBy = () => {};
  window.Element.prototype.scrollIntoView = function () {};
  window.Element.prototype.getClientRects = function () {
    return this.isConnected ? [this.getBoundingClientRect()] : [];
  };
  const rects = new Map();
  const defaultRect = { left: 10, top: 20, width: 120, height: 40 };
  window.Element.prototype.getBoundingClientRect = function () {
    const r = rects.get(this) || defaultRect;
    return { x: r.left, y: r.top, ...r, right: r.left + r.width, bottom: r.top + r.height };
  };
  let pointTarget = null;
  document.elementFromPoint = () => pointTarget;
  window.createImageBitmap = async () => ({ width: window.innerWidth * 2, height: window.innerHeight * 2, close() {} });
  const draws = [];
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage: (...args) => draws.push(args) };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function (type = 'image/png') {
    return type === 'image/jpeg' ? 'data:image/jpeg;base64,AA==' : PNG;
  };
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => (clipboard.text = t) }, configurable: true });
  const clipboard = { text: null };

  const chrome = createChrome();
  chrome.runtime.sendMessage.mock.mockImplementation(async (msg) => {
    if (msg.type === 'udc:capture') return { ok: true, dataUrl: PNG };
    if (msg.type === 'udc:saveIssue') {
      const group = { id: msg.issue.groupId || 'g-new', title: msg.issue.newGroupTitle || 'Кнопка' };
      return { ok: true, number: 1, group, review: { id: msg.reviewId, title: 'Ревью', count: 1, groups: [{ ...group, count: 1 }], lastGroupId: group.id } };
    }
    return { ok: true };
  });
  window.chrome = chrome;

  if (inject) {
    window.eval(ICONS_SRC);
    window.eval(instrumentedContentSource());
  }
  const api = window.__udcTest;

  const send = (msg) =>
    new Promise((resolve) => {
      for (const fn of chrome.runtime.onMessage.listeners) fn(msg, {}, resolve);
      setTimeout(() => resolve(undefined), 50);
    });
  const shadow = () => api.host()?.shadowRoot;
  const $ = (sel) => shadow()?.querySelector(sel);
  const fire = (target, type, init = {}) => {
    const Ctor = /key/.test(type) ? window.KeyboardEvent : /pointer/.test(type) ? window.PointerEvent || window.MouseEvent : window.MouseEvent;
    const ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const setRect = (el, r) => rects.set(el, r);
  const pointAt = (el) => (pointTarget = el);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return { dom, window, document, chrome, api, send, shadow, $, fire, setRect, pointAt, draws, clipboard, sleep };
}
