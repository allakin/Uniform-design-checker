import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, safeHref } from '../../lib/url.js';

describe('normalizeUrl', () => {
  test('пустое значение допустимо и даёт пустую ссылку', () => {
    for (const v of ['', '   ', null, undefined]) assert.deepEqual(normalizeUrl(v), { ok: true, url: '' });
  });

  test('полные http(s)-ссылки принимаются как есть (нормализованные URL)', () => {
    assert.deepEqual(normalizeUrl('https://figma.com/file/abc'), { ok: true, url: 'https://figma.com/file/abc' });
    assert.deepEqual(normalizeUrl('http://example.com'), { ok: true, url: 'http://example.com/' });
  });

  test('пробелы по краям обрезаются', () => {
    assert.deepEqual(normalizeUrl('  https://example.com/a  '), { ok: true, url: 'https://example.com/a' });
  });

  test('ссылка без протокола дополняется https://', () => {
    assert.deepEqual(normalizeUrl('figma.com/design/XYZ?node-id=1-2'), { ok: true, url: 'https://figma.com/design/XYZ?node-id=1-2' });
    assert.deepEqual(normalizeUrl('tracker.example-team.com/DEV-1'), { ok: true, url: 'https://tracker.example-team.com/DEV-1' });
  });

  test('сохраняет query и hash', () => {
    assert.equal(normalizeUrl('https://a.b/c?x=1#y').url, 'https://a.b/c?x=1#y');
  });

  test('отклоняет не-http протоколы', () => {
    for (const v of ['javascript:alert(1)', 'ftp://example.com/file', 'file:///etc/passwd', 'data:text/html,<b>x</b>']) {
      assert.equal(normalizeUrl(v).ok, false, v);
    }
  });

  // Известная особенность: при подстановке https:// «mailto:a@b.ru» разбирается как логин:пароль@хост.
  test('mailto: не считается ссылкой', { todo: 'сейчас превращается в https://mailto:a@b.ru/' }, () => {
    assert.equal(normalizeUrl('mailto:a@b.ru').ok, false);
  });

  test('отклоняет текст, не похожий на ссылку', () => {
    for (const v of ['просто текст', 'localhost', 'http://localhost:3000', 'abc', 'https://']) {
      assert.equal(normalizeUrl(v).ok, false, v);
    }
  });

  test('принимает IDN и кириллические домены', () => {
    const r = normalizeUrl('пример.рф/страница');
    assert.equal(r.ok, true);
    assert.match(r.url, /^https:\/\/xn--/);
  });

  test('приводит число к строке и не падает', () => {
    assert.doesNotThrow(() => normalizeUrl(123));
  });

  // Известная особенность: WHATWG URL трактует «123» как IPv4 0.0.0.123.
  test('голое число не считается ссылкой', { todo: 'сейчас превращается в https://0.0.0.123/' }, () => {
    assert.equal(normalizeUrl('123').ok, false);
  });
});

describe('safeHref', () => {
  test('пропускает только http(s)', () => {
    assert.equal(safeHref('https://example.com/x'), 'https://example.com/x');
    assert.equal(safeHref('http://example.com'), 'http://example.com/');
  });

  test('опасные и некорректные ссылки превращает в пустую строку', () => {
    for (const v of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///x', 'figma.com/x', '', null, undefined, 42]) {
      assert.equal(safeHref(v), '', String(v));
    }
  });

  test('символы для HTML-инъекции кодируются URL-парсером', () => {
    const href = safeHref('https://example.com/"><script>alert(1)</script>');
    assert.ok(!href.includes('"') && !href.includes('<'), href);
  });
});
