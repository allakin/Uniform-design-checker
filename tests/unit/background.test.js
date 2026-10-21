import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv, makeIssue } from '../helpers/env.js';
import { MemDir } from '../helpers/fs.js';
import { readFileSync } from 'node:fs';
import { codeFingerprint, REOPEN_KEY } from '../../lib/code-version.js';
import * as store from '../../lib/store.js';
import * as folder from '../../lib/folder.js';

let loads = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Каждый тест получает свежий экземпляр сервис-воркера со своим моком chrome.
async function loadBackground({ url = 'https://example.com/catalog', withFolder = true, withReview = true } = {}) {
  const env = installEnv({ tabs: [{ url }] });
  await import(`../../background.js?instance=${++loads}`);
  let root = null;
  if (withFolder) {
    root = new MemDir('uniform-reviews-results');
    await folder.setDir(root);
  }
  const review = withReview ? await store.createReview({ title: 'Текущее' }) : null;
  const send = (msg, sender = { tab: { id: 1, windowId: 7 } }) =>
    new Promise((resolve) => {
      const [listener] = env.chrome.runtime.onMessage.listeners;
      const async = listener(msg, sender, resolve);
      if (async !== true) resolve({ handled: false, returned: async });
    });
  return { ...env, root, review, send, tab: env.chrome.tabs.list[0] };
}

describe('маршрутизация сообщений', () => {
  test('регистрирует ровно один обработчик сообщений, команд и изменений хранилища', async () => {
    const { chrome } = await loadBackground({ withFolder: false, withReview: false });
    assert.equal(chrome.runtime.onMessage.listeners.size, 1);
    assert.equal(chrome.commands.onCommand.listeners.size, 1);
    assert.equal(chrome.storage.onChanged.listeners.size, 1);
  });

  test('чужие сообщения и udc:ping не обрабатываются (ответит контент-скрипт)', async () => {
    const { send } = await loadBackground();
    for (const msg of [{ type: 'other' }, {}, null, { type: 'udc:ping' }]) {
      assert.deepEqual(await send(msg), { handled: false, returned: false });
    }
  });

  test('неизвестный udc:* → ok:false с понятной ошибкой', async () => {
    const { send } = await loadBackground();
    assert.deepEqual(await send({ type: 'udc:unknown' }), { ok: false, error: 'Неизвестное сообщение: udc:unknown' });
  });
});

describe('udc:startPick', () => {
  test('служебные страницы браузера запрещены', async () => {
    for (const url of ['chrome://extensions', 'browser://settings', 'about:blank', 'chrome-extension://id/x.html', '']) {
      const { send, tab, chrome } = await loadBackground({ url });
      const res = await send({ type: 'udc:startPick', tabId: tab.id });
      assert.equal(res.ok, false, url);
      assert.match(res.error, /служебных страницах/);
      assert.equal(chrome.scripting.executeScript.mock.callCount(), 0);
    }
  });

  test('без подключённой папки открывает страницу настройки', async () => {
    const { send, tab, chrome } = await loadBackground({ withFolder: false });
    const res = await send({ type: 'udc:startPick', tabId: tab.id });
    assert.equal(res.ok, false);
    assert.match(res.error, /подключите папку uniform-reviews-results/);
    const created = chrome.tabs.create.mock.calls.map((c) => c.arguments[0].url);
    assert.deepEqual(created, [chrome.runtime.getURL('pages/setup.html')]);
  });

  test('уже открытую страницу настройки активирует, а не открывает вторую', async () => {
    const { send, tab, chrome } = await loadBackground({ withFolder: false });
    const setup = await chrome.tabs.create({ url: chrome.runtime.getURL('pages/setup.html'), active: false });
    chrome.tabs.create.mock.resetCalls();
    await send({ type: 'udc:startPick', tabId: tab.id });
    assert.equal(chrome.tabs.create.mock.callCount(), 0);
    assert.deepEqual(chrome.tabs.update.mock.calls[0].arguments, [setup.id, { active: true }]);
    assert.deepEqual(chrome.windows.update.mock.calls[0].arguments, [setup.windowId, { focused: true }]);
  });

  test('без текущего ревью — ошибка «Сначала создайте ревью»', async () => {
    const { send, tab } = await loadBackground({ withReview: false });
    assert.deepEqual(await send({ type: 'udc:startPick', tabId: tab.id }), { ok: false, error: 'Сначала создайте ревью' });
  });

  test('autoCreate создаёт ревью с хостом страницы в названии', async () => {
    const { send, tab } = await loadBackground({ withReview: false, url: 'https://shop.example.ru/cart' });
    const res = await send({ type: 'udc:startPick', tabId: tab.id, autoCreate: true });
    assert.equal(res.ok, true);
    const active = await store.getActiveReview();
    assert.match(active.title, /^Ревью shop\.example\.ru от \d{2}\.\d{2}\.\d{4}$/);
  });

  test('autoCreate на file:// — «Ревью страницы от …»', async () => {
    const { send, tab } = await loadBackground({ withReview: false, url: 'file:///Users/me/page.html' });
    await send({ type: 'udc:startPick', tabId: tab.id, autoCreate: true });
    assert.match((await store.getActiveReview()).title, /^Ревью страницы от /);
  });

  test('autoCreate не создаёт второе ревью, если текущее есть', async () => {
    const { send, tab, review } = await loadBackground();
    await send({ type: 'udc:startPick', tabId: tab.id, autoCreate: true });
    assert.equal((await store.listReviews()).length, 1);
    assert.equal(await store.getActiveReviewId(), review.id);
  });

  test('внедряет скрипты, если контент-скрипта нет, и запускает выбор', async () => {
    const { send, tab, chrome, review } = await loadBackground();
    chrome.tabs.sendMessage.mock.mockImplementation(async (_id, msg) => {
      if (msg.type === 'udc:ping') throw new Error('Could not establish connection');
      return { ok: true };
    });
    const res = await send({ type: 'udc:startPick', tabId: tab.id, delay: 3 });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(chrome.scripting.executeScript.mock.calls[0].arguments[0], {
      target: { tabId: tab.id },
      files: ['content/icons.js', 'content/content.js'],
    });
    const start = chrome.tabs.sendMessage.mock.calls.at(-1).arguments;
    assert.deepEqual(start, [tab.id, { type: 'udc:start', review: { id: review.id, title: 'Текущее', count: 0, groups: [], lastGroupId: '' }, delay: 3 }]);
  });

  test('не внедряет повторно, если контент-скрипт отвечает на ping', async () => {
    const { send, tab, chrome } = await loadBackground();
    chrome.tabs.sendMessage.mock.mockImplementation(async (_id, msg) => (msg.type === 'udc:ping' ? { pong: true } : { ok: true }));
    await send({ type: 'udc:startPick', tabId: tab.id });
    assert.equal(chrome.scripting.executeScript.mock.callCount(), 0);
  });

  test('ошибка внедрения на file:// — подсказка про доступ к файлам', async () => {
    const { send, tab, chrome } = await loadBackground({ url: 'file:///tmp/a.html' });
    chrome.scripting.executeScript.mock.mockImplementation(async () => {
      throw new Error('Cannot access contents of url');
    });
    const res = await send({ type: 'udc:startPick', tabId: tab.id });
    assert.equal(res.ok, false);
    assert.match(res.error, /Не удалось подключиться к странице: Cannot access contents of url\./);
    assert.match(res.error, /Разрешить доступ к адресам файлов/);
  });

  test('ошибка внедрения на https — без подсказки про файлы', async () => {
    const { send, tab, chrome } = await loadBackground();
    chrome.scripting.executeScript.mock.mockImplementation(async () => {
      throw new Error('The extensions gallery cannot be scripted');
    });
    const res = await send({ type: 'udc:startPick', tabId: tab.id });
    assert.doesNotMatch(res.error, /адресам файлов/);
  });

  test('несуществующая вкладка → ok:false', async () => {
    const { send } = await loadBackground();
    const res = await send({ type: 'udc:startPick', tabId: 999 });
    assert.equal(res.ok, false);
  });
});

describe('udc:saveIssue', () => {
  test('сохраняет вариант и возвращает его номер в группе, группу и сводку ревью', async () => {
    const { send, review } = await loadBackground();
    const res = await send({ type: 'udc:saveIssue', reviewId: review.id, issue: makeIssue({ group: 'Кнопка' }) });
    const [group] = (await store.getReview(review.id)).groups;
    assert.equal(group.title, 'Кнопка');
    assert.deepEqual(res, {
      ok: true,
      number: 1,
      group: { id: group.id, title: 'Кнопка' },
      review: { id: review.id, title: 'Текущее', count: 1, groups: [{ id: group.id, title: 'Кнопка', count: 1 }], lastGroupId: group.id },
    });
    const again = await send({ type: 'udc:saveIssue', reviewId: review.id, issue: { ...makeIssue(), groupId: group.id, newGroupTitle: undefined } });
    assert.equal(again.number, 2);
    assert.deepEqual(again.review.groups, [{ id: group.id, title: 'Кнопка', count: 2 }]);
  });

  test('группу удалили, пока была открыта форма, — ok:false с объяснением', async () => {
    const { send, review } = await loadBackground();
    const res = await send({ type: 'udc:saveIssue', reviewId: review.id, issue: { groupId: 'gone' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /Группа не найдена/);
  });

  test('в удалённое ревью — ok:false с подсказкой', async () => {
    const { send } = await loadBackground();
    const res = await send({ type: 'udc:saveIssue', reviewId: 'gone', issue: {} });
    assert.equal(res.ok, false);
    assert.match(res.error, /создайте новое в окне расширения/);
  });
});

describe('udc:openReview', () => {
  test('открывает страницу ревью с экранированным id', async () => {
    const { send, chrome } = await loadBackground();
    assert.deepEqual(await send({ type: 'udc:openReview', reviewId: 'a b&c' }), { ok: true });
    assert.equal(chrome.tabs.create.mock.calls[0].arguments[0].url, chrome.runtime.getURL('pages/review.html?id=a%20b%26c'));
  });
});

describe('udc:capture', () => {
  test('снимает видимую область окна отправителя в PNG', async () => {
    const { send, chrome } = await loadBackground();
    const res = await send({ type: 'udc:capture' }, { tab: { id: 1, windowId: 42 } });
    assert.equal(res.ok, true);
    assert.match(res.dataUrl, /^data:image\/png/);
    assert.deepEqual(chrome.tabs.captureVisibleTab.mock.calls[0].arguments, [42, { format: 'png' }]);
  });

  test('соблюдает лимит captureVisibleTab: не чаще раза в 600 мс', async () => {
    const { send, chrome } = await loadBackground();
    const times = [];
    chrome.tabs.captureVisibleTab.mock.mockImplementation(async () => (times.push(Date.now()), 'data:image/png;base64,AA=='));
    await Promise.all([send({ type: 'udc:capture' }), send({ type: 'udc:capture' })]);
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 590, `интервал ${times[1] - times[0]} мс`);
  });

  test('ошибка снимка не блокирует следующие', async () => {
    const { send, chrome } = await loadBackground();
    let n = 0;
    chrome.tabs.captureVisibleTab.mock.mockImplementation(async () => {
      if (n++ === 0) throw new Error('quota');
      return 'data:image/png;base64,AA==';
    });
    const [a, b] = await Promise.all([send({ type: 'udc:capture' }), send({ type: 'udc:capture' })]);
    assert.deepEqual(a, { ok: false, error: 'quota' });
    assert.equal(b.ok, true);
  });
});

describe('горячая клавиша', () => {
  test('start-pick запускает выбор на вкладке с автосозданием ревью', async () => {
    const { chrome, tab } = await loadBackground({ withReview: false });
    chrome.tabs.sendMessage.mock.mockImplementation(async (_id, msg) => (msg.type === 'udc:ping' ? { pong: true } : { ok: true }));
    await Promise.all(chrome.commands.onCommand.dispatch('start-pick', tab));
    assert.ok(await store.getActiveReview());
    assert.equal(chrome.tabs.sendMessage.mock.calls.at(-1).arguments[1].type, 'udc:start');
  });

  test('без tab берёт активную вкладку', async () => {
    const { chrome } = await loadBackground();
    chrome.tabs.sendMessage.mock.mockImplementation(async (_id, msg) => (msg.type === 'udc:ping' ? { pong: true } : { ok: true }));
    await Promise.all(chrome.commands.onCommand.dispatch('start-pick', undefined));
    assert.equal(chrome.tabs.query.mock.calls[0].arguments[0].active, true);
    assert.equal(chrome.tabs.sendMessage.mock.calls.at(-1).arguments[0], 1);
  });

  test('другие команды игнорируются', async () => {
    const { chrome, tab } = await loadBackground();
    await Promise.all(chrome.commands.onCommand.dispatch('other', tab));
    assert.equal(chrome.tabs.sendMessage.mock.callCount(), 0);
  });

  test('ошибки не выбрасываются, а пишутся в консоль', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { chrome, tab } = await loadBackground({ url: 'chrome://newtab' });
    await Promise.all(chrome.commands.onCommand.dispatch('start-pick', tab));
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[1], /служебных страницах/);
  });
});

describe('автосохранение в папку', () => {
  test('изменения ревью через ~1 с пишутся на диск одной записью', async () => {
    const { root, review } = await loadBackground();
    const write = mock.method(MemDir.prototype, 'getDirectoryHandle');
    try {
      await store.addIssue(review.id, makeIssue({ group: 'a' }));
      await store.addIssue(review.id, makeIssue({ group: 'b' }));
      await sleep(400);
      assert.deepEqual(root.list(), [], 'до истечения задержки ничего не пишется');
      await sleep(900);
      const [sub] = root.list();
      assert.match(sub, /^Текущее — /);
      const json = JSON.parse(root.at(`${sub}/review.json`).text());
      assert.equal(json.issues.length, 2);
      // одна синхронизация: подпапка ревью открывается на запись один раз
      // (без create — только проверка, не занято ли имя чужой папкой на диске)
      assert.equal(write.mock.calls.filter((c) => c.this === root && c.arguments[1]?.create).length, 1);
    } finally {
      write.mock.restore();
    }
  });

  test('удаление ревью не запускает запись', async () => {
    const { root, review } = await loadBackground();
    await sleep(1100); // отработает запись после создания
    for (const name of root.list()) await root.removeEntry(name, { recursive: true });
    await store.deleteReview(review.id);
    await sleep(1100);
    assert.deepEqual(root.list(), []);
  });
});

describe('версия кода фонового скрипта', () => {
  // fetch файлов расширения → чтение с диска.
  const ROOT = new URL('../../', import.meta.url);
  function mockFetch(t) {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const path = String(url).replace(/^chrome-extension:\/\/[^/]+\//, '');
      return new Response(readFileSync(new URL(path, ROOT)));
    });
  }

  test('udc:codeVersion отдаёт отпечаток кода, с которым запущен фоновый скрипт', async (t) => {
    mockFetch(t);
    const { send } = await loadBackground();
    const res = await send({ type: 'udc:codeVersion' });
    assert.equal(res.ok, true);
    assert.match(res.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(res.fingerprint, await codeFingerprint());
  });

  test('файлы не прочитать → отпечатка нет (null), без ошибки', async () => {
    const { send } = await loadBackground();
    assert.deepEqual(await send({ type: 'udc:codeVersion' }), { ok: true, fingerprint: null });
  });

  test('после «Перезагрузить расширение» снова открывает страницу ревью', async () => {
    const env = installEnv({ tabs: [{ url: 'https://example.com' }] });
    const url = env.chrome.runtime.getURL('pages/review.html?id=r1');
    await env.chrome.storage.local.set({ [REOPEN_KEY]: url });
    await import(`../../background.js?instance=${++loads}`);
    await sleep(20);
    assert.equal(env.chrome.tabs.create.mock.calls[0].arguments[0].url, url);
    assert.equal(env.chrome.storage.local.data.has(REOPEN_KEY), false);
  });

  test('чужой адрес после перезагрузки не открывается', async () => {
    const env = installEnv({ tabs: [{ url: 'https://example.com' }] });
    await env.chrome.storage.local.set({ [REOPEN_KEY]: 'https://evil.example/' });
    await import(`../../background.js?instance=${++loads}`);
    await sleep(20);
    assert.equal(env.chrome.tabs.create.mock.callCount(), 0);
  });
});
