import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent, closeAllContent, CONTENT_SRC } from '../helpers/content.js';
import { PNG } from '../helpers/env.js';

after(closeAllContent);

// Объекты из jsdom-окна — из другого realm; сравниваем их «плоские» копии.
const plain = (v) => JSON.parse(JSON.stringify(v));
import { escapeHtml } from '../../lib/report.js';

describe('синхронность копий с lib/', () => {
  const { api } = loadContent();

  test('esc совпадает с escapeHtml из lib/report.js', () => {
    for (const v of [`<a href="x" title='y'>&</a>`, null, undefined, 0, 'обычный текст']) assert.equal(api.esc(v), escapeHtml(v));
  });
});

describe('цвета', () => {
  const { api } = loadContent();

  test('parseColor: rgb, rgba, современный синтаксис', () => {
    assert.deepEqual(plain(api.parseColor('rgb(255, 0, 10)')), { r: 255, g: 0, b: 10, a: 1 });
    assert.deepEqual(plain(api.parseColor('rgba(1, 2, 3, 0.5)')), { r: 1, g: 2, b: 3, a: 0.5 });
    assert.deepEqual(plain(api.parseColor('rgb(1 2 3 / 0.25)')), { r: 1, g: 2, b: 3, a: 0.25 });
  });

  test('parseColor: всё прочее → null', () => {
    for (const v of ['red', '#fff', 'transparent', 'rgb(1, 2)', 'rgb(a, b, c)', '', null, undefined]) assert.equal(api.parseColor(v), null, String(v));
  });

  test('hex: верхний регистр, альфа только если < 1, значения ограничены 0..255', () => {
    assert.equal(api.hex({ r: 255, g: 0, b: 16 }), '#FF0010');
    assert.equal(api.hex({ r: 0, g: 0, b: 0, a: 0.5 }), '#00000080');
    assert.equal(api.hex({ r: 300, g: -5, b: 127.6 }), '#FF0080');
  });

  test('hexify: rgb() внутри теней/градиентов, короткие HEX разворачиваются', () => {
    assert.equal(api.hexify('0 1px 2px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgb(255, 255, 255)'), '0 1px 2px #00000033, inset 0 0 0 1px #FFFFFF');
    assert.equal(api.hexify('linear-gradient(#abc, #1234)'), 'linear-gradient(#AABBCC, #11223344)');
    assert.equal(api.hexify('#a1b2c3'), '#A1B2C3');
    assert.equal(api.hexify('12px'), '12px');
  });

  test('blend: непрозрачный верх перекрывает низ, полупрозрачный смешивается', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    assert.deepEqual(plain(api.blend({ r: 0, g: 0, b: 0, a: 1 }, white)), { r: 0, g: 0, b: 0, a: 1 });
    const half = api.blend({ r: 0, g: 0, b: 0, a: 0.5 }, white);
    assert.equal(Math.round(half.r), 128);
    assert.equal(half.a, 1);
    assert.deepEqual(plain(api.blend({ r: 1, g: 1, b: 1, a: 0 }, { r: 1, g: 1, b: 1, a: 0 })), { r: 0, g: 0, b: 0, a: 0 });
  });

  test('luminance по WCAG: чёрный 0, белый 1', () => {
    assert.equal(api.luminance({ r: 0, g: 0, b: 0 }), 0);
    assert.ok(Math.abs(api.luminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-9);
  });
});

describe('мелкие помощники', () => {
  const { api, document } = loadContent();

  test('shorthand сворачивает 4 значения как CSS', () => {
    assert.equal(api.shorthand(['1px', '1px', '1px', '1px']), '1px');
    assert.equal(api.shorthand(['1px', '2px', '1px', '2px']), '1px 2px');
    assert.equal(api.shorthand(['1px', '2px', '3px', '2px']), '1px 2px 3px');
    assert.equal(api.shorthand(['1px', '2px', '3px', '4px']), '1px 2px 3px 4px');
  });

  test('clip обрезает длинные значения с многоточием', () => {
    assert.equal(api.clip('abc', 5), 'abc');
    assert.equal(api.clip('abcdefgh', 5), 'abcde…');
    assert.equal(api.clip('x'.repeat(200)).length, 161);
  });

  test('arrow: «авторское → итоговое» только если они различаются', () => {
    assert.equal(api.arrow('var(--a)', '#FFF'), 'var(--a) → #FFF');
    assert.equal(api.arrow('red', 'red'), 'red');
    assert.equal(api.arrow('var(--a)', ''), 'var(--a)');
  });

  test('unionRect и dragRect', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(api.unionRect({ left: 10, top: 10, right: 50, bottom: 30 }, { left: 0, top: 20, right: 40, bottom: 80 }))), {
      left: 0, top: 10, right: 50, bottom: 80, width: 50, height: 70,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(api.dragRect({ clientX: 10, clientY: 5 }, { x: 50, y: 40 }))), {
      left: 10, top: 5, width: 40, height: 35, right: 50, bottom: 40,
    });
  });

  test('describe: тег, id и до двух классов', () => {
    document.body.innerHTML = '<div id="card" class="a b c"></div><svg class="icon"></svg><p></p>';
    assert.equal(api.describe(document.getElementById('card')), 'div#card.a.b');
    assert.equal(api.describe(document.querySelector('p')), 'p');
    assert.equal(api.describe(document.querySelector('svg')), 'svg'); // className у SVG — не строка
  });
});

describe('cssPath', () => {
  const { api, document } = loadContent();

  test('уникальный id — сразу #id', () => {
    document.body.innerHTML = '<main><button id="buy">x</button></main>';
    assert.equal(api.cssPath(document.getElementById('buy')), '#buy');
  });

  test('путь по классам и nth-of-type, обрывается на предке с id', () => {
    document.body.innerHTML = '<section id="list"><ul class="items"><li class="item">1</li><li class="item active">2</li></ul></section>';
    const li = document.querySelectorAll('li')[1];
    const path = api.cssPath(li);
    assert.equal(path, '#list > ul.items > li.item.active:nth-of-type(2)');
    assert.equal(document.querySelector(path), li);
  });

  test('отбрасывает сгенерированные классы (хэши, Tailwind-модификаторы)', () => {
    document.body.innerHTML = '<div class="css-1a2b345 card md:flex [&>p]:x">x</div>';
    assert.equal(api.cssPath(document.querySelector('.card')), 'body > div.card');
  });

  test('неуникальный id не используется как якорь', () => {
    document.body.innerHTML = '<p id="dup">a</p><p id="dup">b</p>';
    const path = api.cssPath(document.querySelectorAll('p')[1]);
    assert.equal(path, '#dup');
  });

  test('не длиннее 5 уровней', () => {
    document.body.innerHTML = '<div><div><div><div><div><div><span>x</span></div></div></div></div></div></div>';
    assert.equal(api.cssPath(document.querySelector('span')).split(' > ').length, 5);
  });

  test('спецсимволы в id экранируются', () => {
    document.body.innerHTML = '<b id="a:b.c">x</b>';
    const path = api.cssPath(document.querySelector('b'));
    assert.equal(document.querySelector(path).id, 'a:b.c');
  });
});

describe('атрибуты и данные элемента', () => {
  const { api, document } = loadContent();

  test('attributesOf оставляет только полезные атрибуты', () => {
    document.body.innerHTML =
      '<a id="x" class="c" href="/p" role="button" aria-label="Купить" data-testid="buy" data-qa-id="q" data-foo="no" style="color:red" onclick="evil()" tabindex="0">x</a>';
    const attrs = JSON.parse(JSON.stringify(api.attributesOf(document.querySelector('a'))));
    assert.deepEqual(Object.keys(attrs).sort(), ['aria-label', 'class', 'data-qa-id', 'data-testid', 'href', 'id', 'role', 'tabindex']);
  });

  test('длинные значения атрибутов обрезаются до 200 символов', () => {
    document.body.innerHTML = `<img alt="${'a'.repeat(500)}">`;
    assert.equal(api.attributesOf(document.querySelector('img')).alt.length, 201);
  });

  test('elementInfo: селектор, имя, текст, размер, атрибуты', () => {
    document.body.innerHTML = '<button id="buy" class="btn">  Купить\n  сейчас </button>';
    const info = api.elementInfo(document.getElementById('buy'));
    assert.equal(info.selector, '#buy');
    assert.equal(info.name, 'button#buy.btn');
    assert.equal(info.text, 'Купить сейчас');
    assert.equal(info.width, 120);
    assert.equal(info.height, 40);
    assert.equal(info.attributes.id, 'buy');
  });

  test('elementInfo: текст ограничен 160 символами', () => {
    document.body.innerHTML = `<p>${'слово '.repeat(100)}</p>`;
    assert.ok(api.elementInfo(document.querySelector('p')).text.length <= 160);
  });
});

describe('CSS-объявления и переменные', () => {
  test('parseDeclarations: скобки, кавычки, !important', () => {
    const { api } = loadContent();
    const d = JSON.parse(
      JSON.stringify(api.parseDeclarations(`color: var(--x, rgb(1, 2, 3)); content: "a;b"; background: url("a;b.png") !important; --empty: ; broken`)),
    );
    assert.deepEqual(d, [
      { prop: 'color', value: 'var(--x, rgb(1, 2, 3))', important: false },
      { prop: 'content', value: '"a;b"', important: false },
      { prop: 'background', value: 'url("a;b.png")', important: true },
      { prop: '--empty', value: '', important: false },
    ]);
    assert.equal(api.parseDeclarations('').length, 0);
  });

  test('collectVariables: свойства через var(), свои и родительские переменные', () => {
    const { api, document } = loadContent({
      html: `<style>
        :root { --brand: #ff0000; --space: 8px; }
        .card { color: var(--brand); padding: var(--space) 4px; --card-bg: var(--surface, #fff); }
        .other { color: blue; }
      </style><div class="card" style="--local: 1">x</div>`,
    });
    const v = JSON.parse(JSON.stringify(api.collectVariables(document.querySelector('.card'))));
    assert.deepEqual(v.used.map(([k]) => k).sort(), ['color', 'padding']);
    assert.deepEqual(v.defined.map(([k]) => k).sort(), ['--card-bg', '--local']);
    const inherited = Object.fromEntries(v.inherited);
    assert.equal(inherited['--brand'], '#FF0000');
    assert.equal(inherited['--space'], '8px');
    assert.equal(inherited['--surface'], '— не задана');
    assert.equal(v.blocked, 0);
    assert.equal(v.truncated, false);
  });

  test('учитывает @media (по matchMedia) и @supports', () => {
    const css = `<style>
      @media (min-width: 9999px) { .a { color: var(--wide); } }
      @media print { .a { border-color: var(--print); } }
      @supports (display: grid) { .a { gap: var(--gap); } }
    </style><div class="a">x</div>`;
    const narrow = loadContent({ html: css, media: (q) => !/9999|print/.test(q) });
    const refs = (env) => env.api.collectVariables(env.document.querySelector('.a')).inherited.map(([k]) => k).sort();
    assert.deepEqual(plain(refs(narrow)), ['--gap']);
    const wide = loadContent({ html: css, media: () => true });
    assert.deepEqual(plain(refs(wide)), ['--gap', '--print', '--wide']);
  });

  test('упрощённый каскад: побеждает последнее объявление, !important сильнее', () => {
    const { api, document } = loadContent({
      html: `<style>.a { color: var(--first) !important; } .a { color: var(--second); } .a { margin: var(--m1); } .a { margin: var(--m2); }</style><div class="a">x</div>`,
    });
    const v = api.collectVariables(document.querySelector('.a'));
    const used = Object.fromEntries(v.used.map(([k, a]) => [k, a]));
    assert.equal(used.color, 'var(--first)');
    assert.equal(used.margin, 'var(--m2)');
  });

  test('inline-стили применяются последними', () => {
    const { api, document } = loadContent({ html: `<style>.a { color: var(--sheet); }</style><div class="a" style="color: var(--inline)">x</div>` });
    const used = Object.fromEntries(api.collectVariables(document.querySelector('.a')).used.map(([k, a]) => [k, a]));
    assert.equal(used.color, 'var(--inline)');
  });

  test('кросс-доменные таблицы стилей считаются, а не роняют сбор', () => {
    const { api, document, window } = loadContent({ html: '<div class="a">x</div>' });
    Object.defineProperty(window.document, 'styleSheets', {
      value: [{ get cssRules() { throw new window.DOMException('blocked', 'SecurityError'); }, media: { mediaText: '' } }],
    });
    const v = api.collectVariables(document.querySelector('.a'));
    assert.equal(v.blocked, 1);
    const styles = api.collectStyles(document.querySelector('.a'));
    assert.match(styles.notes.join(), /1 табл\. стилей с другого домена/);
  });

  test('невалидный селектор в таблице стилей не ломает сбор', () => {
    const { api, document, window } = loadContent({ html: '<div class="a">x</div>' });
    const rule = Object.create(window.CSSStyleRule.prototype, {
      selectorText: { value: ':unknown-pseudo(' },
      style: { value: { cssText: 'color: var(--x)' } },
      cssRules: { value: [] },
    });
    Object.defineProperty(window.document, 'styleSheets', { value: [{ cssRules: [rule], media: { mediaText: '' } }] });
    assert.doesNotThrow(() => api.collectVariables(document.querySelector('.a')));
  });

  test('слишком много переменных — список обрезается до 60 с пометкой', () => {
    const decl = Array.from({ length: 70 }, (_, i) => `--v${i}: ${i}px`).join('; ');
    const { api, document } = loadContent({ html: `<div class="a" style="${decl}">x</div>` });
    const styles = api.collectStyles(document.querySelector('.a'));
    assert.equal(styles.variables.defined.length, 60);
    assert.equal(styles.variables.truncated, true);
    assert.match(styles.notes.join(), /Показаны не все переменные/);
  });

  test('стили Shadow DOM учитываются для элементов внутри теневого дерева', () => {
    const { api, document } = loadContent({ html: '<div id="h"></div>' });
    const root = document.getElementById('h').attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.in { color: var(--shadow-token); }</style><span class="in">x</span>';
    const v = api.collectVariables(root.querySelector('.in'));
    assert.deepEqual(plain(v.used.map(([k]) => k)), ['color']);
  });
});

describe('collectStyles', () => {
  test('группы стилей: только значимые значения, цвета в HEX', () => {
    const { api, document } = loadContent({
      html: `<div id="box" style="display: flex; gap: 12px; padding: 8px 16px; margin: 0; background-color: rgb(255, 0, 0); border: 1px solid rgb(0, 0, 0); border-top-left-radius: 4px; border-top-right-radius: 4px; border-bottom-right-radius: 4px; border-bottom-left-radius: 4px; opacity: 0.5; position: relative; z-index: 3; color: rgb(17, 17, 17); font-size: 14px">Текст</div>`,
    });
    const { groups, contrast } = api.collectStyles(document.getElementById('box'));
    const get = (title) => Object.fromEntries(groups.find((g) => g.title === title)?.rows || []);
    assert.equal(get('Размер').width, '120px');
    assert.equal(get('Отступы').padding, '8px 16px');
    assert.equal(get('Отступы').margin, undefined);
    assert.equal(get('Отступы').gap, '12px');
    assert.equal(get('Цвета')['background-color'], '#FF0000');
    assert.equal(get('Цвета').color, '#111111');
    assert.equal(get('Цвета').opacity, '0.5');
    assert.equal(get('Рамка').border, '1px solid #000000');
    assert.equal(get('Рамка')['border-radius'], '4px');
    assert.equal(get('Раскладка').display, 'flex');
    assert.equal(get('Раскладка').position, 'relative');
    assert.equal(get('Раскладка')['z-index'], '3');
    assert.equal(get('Типографика')['font-size'], '14px');
    for (const g of groups) for (const [, v] of g.rows) assert.ok(v, `пустое значение в «${g.title}»`);
    assert.ok(contrast);
  });

  test('без текста нет типографики и контраста', () => {
    const { api, document } = loadContent({ html: '<div id="e" style="width: 10px"></div>' });
    const s = api.collectStyles(document.getElementById('e'));
    assert.ok(!s.groups.some((g) => g.title === 'Типографика'));
    assert.equal(s.contrast, null);
  });

  test('прозрачный фон не показывается, data: URL в фоне сокращается', () => {
    const { api, document } = loadContent({
      html: `<div id="e" style="background-color: rgba(0, 0, 0, 0); background-image: url(&quot;data:image/png;base64,AAAA&quot;)"></div>`,
    });
    const colors = Object.fromEntries(api.collectStyles(document.getElementById('e')).groups.find((g) => g.title === 'Цвета').rows);
    assert.equal(colors['background-color'], undefined);
    assert.equal(colors['background-image'], 'url(data:…)');
  });

  test('разные стороны рамки — раздельные свойства', () => {
    const { api, document } = loadContent({
      html: `<div id="e" style="border-style: solid; border-width: 1px 2px; border-color: rgb(1, 1, 1)"></div>`,
    });
    const border = Object.fromEntries(api.collectStyles(document.getElementById('e')).groups.find((g) => g.title === 'Рамка').rows);
    assert.equal(border.border, undefined);
    assert.equal(border['border-width'], '1px 2px');
  });
});

describe('контраст текста (WCAG)', () => {
  test('чёрный на белом — 21:1, AA и AAA', () => {
    const { api, document } = loadContent({ html: '<div style="background-color: rgb(255, 255, 255)"><p id="t" style="color: rgb(0, 0, 0); font-size: 16px">Привет мир</p></div>' });
    const c = api.contrastInfo(document.getElementById('t'));
    assert.equal(c.ratio, 21);
    assert.equal(c.aa, true);
    assert.equal(c.aaa, true);
    assert.equal(c.large, false);
    assert.equal(c.text, '#000000');
    assert.equal(c.background, '#FFFFFF');
    assert.equal(c.sample, 'Привет мир');
    assert.equal(c.approx, false);
  });

  test('серый #777 на белом — 4.48:1, не проходит AA для обычного текста, проходит для крупного', () => {
    const html = (size, weight = 400) =>
      `<div style="background-color: rgb(255, 255, 255)"><p id="t" style="color: rgb(119, 119, 119); font-size: ${size}; font-weight: ${weight}">Текст</p></div>`;
    const { api, document } = loadContent({ html: html('16px') });
    const small = api.contrastInfo(document.getElementById('t'));
    assert.equal(small.ratio, 4.48);
    assert.equal(small.aa, false);
    const big = loadContent({ html: html('24px') });
    const c = big.api.contrastInfo(big.document.getElementById('t'));
    assert.equal(c.large, true);
    assert.equal(c.aa, true);
    assert.equal(c.aaa, false);
    const boldish = loadContent({ html: html('19px', 700) });
    assert.equal(boldish.api.contrastInfo(boldish.document.getElementById('t')).large, true);
  });

  test('полупрозрачные фоны родителей смешиваются, без фона — белый', () => {
    const { api, document } = loadContent({
      html: '<div style="background-color: rgb(0, 0, 0)"><div style="background-color: rgba(255, 255, 255, 0.5)"><span id="t" style="color: rgb(255, 255, 255)">x</span></div></div><span id="n" style="color: rgb(0, 0, 0)">y</span>',
    });
    assert.equal(api.contrastInfo(document.getElementById('t')).background, '#808080');
    assert.equal(api.effectiveBackground(document.getElementById('n')).color.r, 255);
  });

  test('градиент или картинка под текстом → approx', () => {
    const { api, document } = loadContent({ html: '<div style="background-image: linear-gradient(red, blue)"><b id="t" style="color: rgb(0, 0, 0)">x</b></div>' });
    assert.equal(api.contrastInfo(document.getElementById('t')).approx, true);
  });

  test('текст берётся из первого видимого текстового узла', () => {
    const { api, document } = loadContent({ html: '<div id="w">   <span></span><i style="color: rgb(0, 0, 0)">  первый   видимый  </i><b>второй</b></div>' });
    const t = api.textHost(document.getElementById('w'));
    assert.equal(t.node.tagName, 'I');
    assert.equal(t.sample, 'первый видимый');
  });
});

describe('форма без стилей элемента', () => {
  test('в форме нет блока «Стили и данные элемента» — поиск вариантов только визуальный', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const el = env.document.getElementById('buy');
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(250);
    assert.equal(env.api.state.mode, 'form');
    assert.equal(env.$('details.specs'), null);
    assert.equal(env.$('[data-act=copy-css]'), null);
  });
});

describe('нативный select', () => {
  test('isDropdownSelect: только одиночный выпадающий список с опциями', () => {
    const { api, document } = loadContent({
      html: '<select id="a"><option>1</option></select><select id="b" multiple><option>1</option></select><select id="c" size="4"><option>1</option></select><select id="d"></select><div id="e"></div>',
    });
    const is = (id) => api.isDropdownSelect(document.getElementById(id));
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(is), [true, false, false, false, false]);
  });

  test('openSelectList рисует копию списка: группы, выбранный и недоступный пункты', () => {
    const { api, document } = loadContent({
      html: `<select id="s"><option>Один</option><optgroup label="Группа"><option selected>Два</option><option disabled>Три</option></optgroup></select>`,
    });
    const list = api.openSelectList(document.getElementById('s'));
    assert.ok(list.hasAttribute('data-udc-select-list'));
    assert.equal(list.parentElement, document.body);
    const rows = [...list.children];
    assert.deepEqual(rows.map((r) => r.textContent), ['Один', 'Группа', 'Два', 'Три']);
    assert.match(rows[1].style.cssText, /font-weight: 700/);
    assert.match(rows[2].style.cssText, /background/);
    assert.match(rows[3].style.cssText, /color: (#999|rgb\(153, 153, 153\))/);
  });

  test('длинный список обрезается до 15 пунктов с «… ещё N»', () => {
    const opts = Array.from({ length: 20 }, (_, i) => `<option>${i}</option>`).join('');
    const { api, document } = loadContent({ html: `<select id="s">${opts}</select>` });
    const list = api.openSelectList(document.getElementById('s'));
    assert.equal(list.children.length, 16);
    assert.equal(list.lastChild.textContent, '… ещё 5');
  });
});

describe('жизненный цикл контент-скрипта', () => {
  test('отвечает на ping', async () => {
    const { send } = loadContent();
    assert.deepEqual(plain(await send({ type: 'udc:ping' })), { pong: true });
  });

  test('повторное внедрение при живом экземпляре — no-op', () => {
    const env = loadContent();
    const first = env.window.__udcInstance;
    env.window.eval(CONTENT_SRC);
    assert.equal(env.window.__udcInstance, first);
    assert.equal(env.chrome.runtime.onMessage.listeners.size, 1);
  });

  test('«осиротевший» экземпляр (после перезагрузки расширения) заменяется новым', () => {
    const env = loadContent();
    env.api.startPicking({ id: 'r', title: 'R' });
    const old = env.window.__udcInstance;
    const oldListeners = new Set(env.chrome.runtime.onMessage.listeners);
    old.alive = () => false; // контекст старого расширения уничтожен
    env.window.eval(CONTENT_SRC);
    assert.notEqual(env.window.__udcInstance, old);
    assert.equal(env.document.querySelectorAll('udc-review-root').length, 0, 'старый UI удалён');
    for (const l of oldListeners) assert.ok(!env.chrome.runtime.onMessage.listeners.has(l), 'старый обработчик снят');
  });

  test('UI живёт в закрытом от страницы Shadow DOM поверх всего', async () => {
    const { send, document, api } = loadContent();
    await send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const host = document.querySelector('udc-review-root');
    assert.ok(host.shadowRoot);
    assert.match(host.style.cssText, /z-index: 2147483647/);
    assert.equal(api.host(), host);
  });
});

describe('режим выбора', () => {
  async function picking(opts) {
    const env = loadContent(opts);
    await env.send({ type: 'udc:start', review: { id: 'rev-1', title: 'Ревью оплаты', count: 0 } });
    return env;
  }

  test('udc:start показывает подсказку и включает выбор', async () => {
    const { $, api } = await picking();
    assert.equal(api.state.mode, 'picking');
    assert.equal($('.bar').hidden, false);
  });

  test('наведение подсвечивает элемент с именем и размером', async () => {
    const { $, document, fire, pointAt } = await picking();
    const btn = document.getElementById('buy');
    pointAt(btn);
    fire(document.body, 'mousemove', { clientX: 30, clientY: 30 });
    assert.equal($('.hl').hidden, false);
    assert.match($('.hl-label').textContent, /^button#buy\.btn\.primary120 × 40$/);
  });

  test('↑ поднимается к родителю, ↓ возвращается к дочернему', async () => {
    const { document, fire, pointAt, api, window } = await picking();
    const btn = document.getElementById('buy');
    pointAt(btn);
    fire(document.body, 'mousemove');
    fire(window, 'keydown', { key: 'ArrowUp' });
    assert.equal(api.state.hovered.tagName, 'MAIN');
    fire(window, 'keydown', { key: 'ArrowDown' });
    assert.equal(api.state.hovered, btn);
  });

  test('Esc отменяет выбор', async () => {
    const { fire, window, api, $ } = await picking();
    fire(window, 'keydown', { key: 'Escape' });
    assert.equal(api.state.mode, 'idle');
    assert.equal($('.bar').hidden, true);
  });

  test('клики и нажатия не доходят до страницы (меню не закроются)', async () => {
    const { document, fire, pointAt } = await picking();
    let pageGot = 0;
    for (const t of ['mousedown', 'mouseup', 'contextmenu', 'dblclick']) document.addEventListener(t, () => pageGot++);
    pointAt(document.getElementById('buy'));
    for (const t of ['mousedown', 'mouseup', 'contextmenu', 'dblclick']) fire(document.getElementById('buy'), t);
    assert.equal(pageGot, 0);
  });

  test('повторный udc:start при открытой форме не теряет введённое', async () => {
    const env = await picking();
    env.pointAt(env.document.getElementById('buy'));
    env.fire(env.document.getElementById('buy'), 'click');
    await env.sleep(250);
    assert.equal(env.api.state.mode, 'form');
    env.$('[name=newGroup]').value = 'Черновик';
    assert.deepEqual(plain(await env.send({ type: 'udc:start', review: { id: 'rev-1' } })), { ok: true, busy: true });
    assert.equal(env.$('[name=newGroup]').value, 'Черновик');
  });

  test('udc:start с delay запускает обратный отсчёт, затем выбор', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' }, delay: 1 });
    assert.equal(env.api.state.mode, 'countdown');
    assert.equal(env.$('.countdown').hidden, false);
    assert.equal(env.$('.countdown b').textContent, '1');
    await env.sleep(1100);
    assert.equal(env.api.state.mode, 'picking');
    assert.equal(env.$('.countdown').hidden, true);
  });
});

const GROUPS = [
  { id: 'g-btn', title: 'Кнопка удаления', count: 2 },
  { id: 'g-modal', title: '<b>Модалка</b>', count: 1 },
];

describe('скриншот, форма и сохранение варианта', () => {
  async function formFor(target = '#buy', opts = {}) {
    const { review = { id: 'rev-1', title: 'Ревью оплаты', count: 0 }, ...rest } = opts;
    const env = loadContent(rest);
    await env.send({ type: 'udc:start', review });
    const el = env.document.querySelector(target);
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(250);
    return { ...env, el };
  }

  test('клик снимает элемент и открывает форму с превью и данными', async () => {
    const { api, $, chrome, draws } = await formFor();
    assert.equal(api.state.mode, 'form');
    assert.equal(chrome.runtime.sendMessage.mock.calls[0].arguments[0].type, 'udc:capture');
    assert.ok($('.shot canvas'));
    assert.equal($('.panel-head .sub').textContent, 'Ревью: Ревью оплаты');
    assert.match($('.shot-meta').textContent, /^button#buy\.btn\.primary · 120×40$/);
    // кадр обрезан по элементу с учётом DPR (bitmap в 2 раза больше окна)
    const [, sx, sy, w, h] = draws[0];
    assert.deepEqual([sx, sy, w, h], [20, 40, 240, 80]);
    assert.equal($('.panel-head h2').firstChild.textContent, 'Новый вариант блока');
  });

  test('в ревью ещё нет групп — сразу поле названия новой группы', async () => {
    const { $, shadow, sleep } = await formFor();
    assert.equal($('[data-groups]'), null);
    assert.equal($('[name=newGroup]').hidden, false);
    await sleep(5);
    assert.equal(shadow().activeElement, $('[name=newGroup]'));
  });

  test('без группы не сохраняет и подсвечивает поле', async () => {
    const { $, chrome } = await formFor();
    $('[name=newGroup]').value = '   ';
    $('[data-act=save]').click();
    await Promise.resolve();
    assert.ok($('[name=newGroup]').classList.contains('invalid'));
    assert.equal($('[data-err=group]').hidden, false);
    assert.ok(!chrome.runtime.sendMessage.mock.calls.some((c) => c.arguments[0].type === 'udc:saveIssue'));
  });

  test('группы ревью — кнопками с числом вариантов; по умолчанию выбрана группа последнего варианта', async () => {
    const { $, shadow, sleep } = await formFor('#buy', { review: { id: 'rev-1', title: 'Р', count: 3, groups: GROUPS, lastGroupId: 'g-modal' } });
    const buttons = [...shadow().querySelectorAll('[data-groups] button')];
    assert.deepEqual(buttons.map((b) => b.dataset.group), ['g-btn', 'g-modal', '']);
    assert.equal(buttons[1].querySelector('span').textContent, '<b>Модалка</b>', 'название — текстом, не HTML');
    assert.equal(buttons[0].querySelector('.cnt').textContent, '2');
    assert.equal($('[data-group][aria-pressed=true]').dataset.group, 'g-modal');
    assert.equal($('[name=newGroup]').hidden, true);
    await sleep(5);
    assert.equal(shadow().activeElement, $('[name=note]'), 'группа уже выбрана — курсор в заметке');
  });

  test('«Новая группа» показывает поле названия, выбор группы — прячет', async () => {
    const { $, shadow } = await formFor('#buy', { review: { id: 'rev-1', title: 'Р', groups: GROUPS, lastGroupId: 'g-btn' } });
    $('[data-group=""]').click();
    assert.equal($('[name=newGroup]').hidden, false);
    assert.equal(shadow().activeElement, $('[name=newGroup]'));
    assert.equal($('[data-group][aria-pressed=true]').dataset.group, '');
    $('[data-group=g-btn]').click();
    assert.equal($('[name=newGroup]').hidden, true);
  });

  test('сохранение в существующую группу: groupId и заметка', async () => {
    const { $, chrome, sleep } = await formFor('#buy', { review: { id: 'rev-1', title: 'Р', groups: GROUPS, lastGroupId: 'g-btn' } });
    $('[data-group=g-modal]').click();
    $('[name=note]').value = '  Скругление 4px  ';
    $('[data-act=save]').click();
    await sleep(10);
    const { issue } = chrome.runtime.sendMessage.mock.calls.find((c) => c.arguments[0].type === 'udc:saveIssue').arguments[0];
    assert.equal(issue.groupId, 'g-modal');
    assert.equal(issue.newGroupTitle, undefined);
    assert.equal(issue.note, 'Скругление 4px');
  });

  test('группа последнего варианта не из этого ревью — ничего не выбрано, поле новой группы', async () => {
    const { $ } = await formFor('#buy', { review: { id: 'rev-1', title: 'Р', groups: GROUPS, lastGroupId: 'gone' } });
    assert.equal($('[data-group][aria-pressed=true]').dataset.group, '');
    assert.equal($('[name=newGroup]').hidden, false);
  });

  test('сохранение отправляет полный вариант и показывает уведомление с действиями', async () => {
    const { $, chrome, api, sleep } = await formFor();
    $('[name=newGroup]').value = '  Кнопка удаления  ';
    $('[data-act=save]').click();
    await sleep(10);
    const msg = chrome.runtime.sendMessage.mock.calls.find((c) => c.arguments[0].type === 'udc:saveIssue').arguments[0];
    assert.equal(msg.reviewId, 'rev-1');
    const i = msg.issue;
    assert.equal(i.newGroupTitle, 'Кнопка удаления');
    assert.equal(i.groupId, undefined);
    assert.equal(i.note, '');
    for (const gone of ['title', 'description', 'severity', 'mockupUrl', 'fixImages']) assert.equal(i[gone], undefined, gone);
    assert.match(i.screenshot, /^data:image\/png;base64,/);
    assert.deepEqual(plain(i.page), { url: 'https://shop.example.com/catalog?x=1', title: 'Каталог' });
    assert.equal(i.element.selector, '#buy');
    assert.equal(i.screenshotTruncated, false);
    assert.ok(i.styles.groups.length);
    assert.deepEqual(plain(Object.keys(i.viewport)), ['width', 'height', 'dpr']);
    assert.equal(api.state.mode, 'idle');
    assert.match($('.toast').textContent, /Вариант 1 добавлен в группу «Кнопка удаления»/);
    assert.deepEqual([...$('.toast').querySelectorAll('button')].map((b) => b.textContent).slice(0, 2), ['Ещё блок', 'Открыть ревью']);
  });

  test('следующий блок предлагается в ту же группу, что и прошлый', async () => {
    const env = await formFor();
    env.$('[name=newGroup]').value = 'Кнопка';
    env.$('[data-act=save]').click();
    await env.sleep(10);
    await env.send({ type: 'udc:start' });
    env.pointAt(env.el);
    env.fire(env.el, 'click');
    await env.sleep(250);
    assert.equal(env.$('[data-group][aria-pressed=true]').dataset.group, 'g-new');
    assert.equal(env.$('[data-group=g-new] span').textContent, 'Кнопка');
  });

  test('Enter в поле формы сохраняет', async () => {
    const { $, chrome, fire, sleep } = await formFor();
    $('[name=newGroup]').value = 'Через Enter';
    fire($('[name=newGroup]'), 'keydown', { key: 'Enter' });
    await sleep(10);
    assert.ok(chrome.runtime.sendMessage.mock.calls.some((c) => c.arguments[0].type === 'udc:saveIssue'));
  });

  test('⌘/Ctrl+Enter сохраняет', async () => {
    const { $, chrome, fire, sleep } = await formFor();
    $('[name=newGroup]').value = 'Через хоткей';
    fire($('[name=newGroup]'), 'keydown', { key: 'Enter', metaKey: true });
    await sleep(10);
    assert.ok(chrome.runtime.sendMessage.mock.calls.some((c) => c.arguments[0].type === 'udc:saveIssue'));
  });

  test('ошибка сохранения — форма остаётся, кнопка снова активна, ошибка в уведомлении', async () => {
    const env = await formFor();
    env.chrome.runtime.sendMessage.mock.mockImplementation(async () => ({ ok: false, error: 'Ревью не найдено' }));
    env.$('[name=newGroup]').value = 'x';
    env.$('[data-act=save]').click();
    await env.sleep(10);
    assert.equal(env.api.state.mode, 'form');
    assert.equal(env.$('[data-act=save]').disabled, false);
    assert.ok(env.$('.toast').classList.contains('error'));
    assert.match(env.$('.toast').textContent, /Не сохранилось: Ревью не найдено/);
  });

  test('расширение перезагружено (sendMessage бросает) — понятная ошибка', async () => {
    const env = await formFor();
    env.chrome.runtime.sendMessage.mock.mockImplementation(async () => {
      throw new Error('Extension context invalidated.');
    });
    env.$('[name=newGroup]').value = 'x';
    env.$('[data-act=save]').click();
    await env.sleep(10);
    assert.match(env.$('.toast').textContent, /Extension context invalidated/);
  });

  test('закрытие пустой формы — сразу; с введённым текстом — предупреждение', async () => {
    const env = await formFor();
    env.$('[name=newGroup]').value = 'Черновик';
    env.$('[data-act=cancel]').click();
    assert.ok(env.$('.discard'), 'показано предупреждение');
    env.$('[data-act=stay]').click();
    assert.equal(env.$('.discard'), null);
    assert.equal(env.api.state.mode, 'form');
    env.fire(env.$('[name=newGroup]'), 'keydown', { key: 'Escape' });
    assert.ok(env.$('.discard'));
    env.$('[data-act=discard]').click();
    assert.equal(env.api.state.mode, 'idle');

    const empty = await formFor();
    empty.$('[data-act=cancel]').click();
    assert.equal(empty.api.state.mode, 'idle');
  });

  test('ввод в форме не запускает горячие клавиши сайта', async () => {
    const env = await formFor();
    let siteGot = 0;
    env.window.addEventListener('keydown', () => siteGot++);
    env.document.addEventListener('keydown', () => siteGot++);
    env.fire(env.$('[name=newGroup]'), 'keydown', { key: 'k' });
    assert.equal(siteGot, 0);
  });

  test('«Другой элемент» возвращает в режим выбора, кнопка ⇄ переносит панель', async () => {
    const env = await formFor();
    env.$('[data-act=side]').click();
    assert.equal(env.api.state.panelLeft, true);
    env.$('[data-act=repick]').click();
    assert.equal(env.api.state.mode, 'picking');
  });

  test('элемент нулевого размера — уведомление об ошибке и возврат в исходное состояние', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const el = env.document.getElementById('buy');
    env.setRect(el, { left: 0, top: 0, width: 0, height: 0 });
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(50);
    assert.equal(env.api.state.mode, 'idle');
    assert.match(env.$('.toast').textContent, /Не удалось сделать скриншот: у элемента нулевой размер/);
  });

  test('ошибка снимка из background показывается пользователю', async () => {
    const env = loadContent();
    env.chrome.runtime.sendMessage.mock.mockImplementation(async () => ({ ok: false, error: 'нет доступа к вкладке' }));
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(env.document.getElementById('buy'));
    env.fire(env.document.getElementById('buy'), 'click');
    await env.sleep(250);
    assert.match(env.$('.toast').textContent, /нет доступа к вкладке/);
  });

  test('высокий элемент снимается несколькими кадрами и склеивается', async () => {
    const env = loadContent({ html: '<article id="long">Длинная статья</article>' });
    const el = env.document.getElementById('long');
    let scrolled = 0;
    env.window.scrollTo = (o) => (scrolled = o.top);
    Object.defineProperty(env.window, 'scrollY', { get: () => scrolled });
    // элемент высотой 2000px; при прокрутке его верх смещается
    env.window.Element.prototype.getBoundingClientRect = function () {
      if (this !== el) return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
      const top = -scrolled;
      return { left: 0, top, width: 500, height: 2000, right: 500, bottom: top + 2000 };
    };
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(1500);
    const captures = env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;
    assert.equal(captures, Math.ceil(2000 / env.window.innerHeight));
    assert.equal(env.api.state.mode, 'form');
  });

  // Страница листается не окном, а внутренним контейнером: <main overflow:auto> высотой 800px с отступом 60px сверху.
  function innerScroller(env, main, contentHeight) {
    let top = 0;
    const box = { left: 0, top: 60, width: 1000, height: 800, right: 1000, bottom: 860 };
    Object.defineProperties(main, {
      scrollTop: { get: () => top, set: (v) => (top = Math.max(0, Math.min(v, contentHeight - 800))), configurable: true },
      scrollHeight: { get: () => contentHeight, configurable: true },
      clientHeight: { get: () => 800, configurable: true },
      clientWidth: { get: () => 1000, configurable: true },
    });
    env.window.innerHeight = 1000;
    return { box, scrollTop: () => top, setScrollTop: (v) => (top = v) };
  }

  test('высокий блок во внутреннем скролл-контейнере склеивается прокруткой контейнера, а не окна', async () => {
    const env = loadContent({ html: '<main id="main" style="overflow-y:auto"><article id="long">Длинная форма</article></main>' });
    const main = env.document.getElementById('main');
    const el = env.document.getElementById('long');
    const s = innerScroller(env, main, 2000);
    let windowScrolls = 0;
    env.window.scrollTo = (o) => o.top && windowScrolls++;
    env.window.Element.prototype.getBoundingClientRect = function () {
      if (this === main) return s.box;
      if (this !== el) return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
      const top = 60 - s.scrollTop();
      return { left: 0, top, width: 500, height: 2000, right: 500, bottom: top + 2000 };
    };
    el.scrollIntoView = () => s.setScrollTop(0);
    s.setScrollTop(300);
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(1500);
    const captures = env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;
    assert.equal(captures, 3); // 800 + 800 + 400
    assert.equal(windowScrolls, 0);
    assert.equal(env.api.state.shot.truncated, false);
    assert.equal(env.api.state.shot.height, 2000 * 2);
    assert.equal(s.scrollTop(), 300, 'прокрутка контейнера возвращается на место');
  });

  test('выбранный прокручиваемый контейнер снимается со всем содержимым', async () => {
    const env = loadContent({ html: '<main id="main" style="overflow-y:auto"><p>Форма</p></main>' });
    const main = env.document.getElementById('main');
    const s = innerScroller(env, main, 1800);
    env.window.Element.prototype.getBoundingClientRect = function () {
      return this === main ? s.box : { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
    };
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(main);
    env.fire(main, 'click');
    await env.sleep(1500);
    const captures = env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;
    assert.equal(captures, 3); // 800 + 800 + 200
    assert.equal(env.api.state.shot.truncated, false);
    assert.equal(env.api.state.shot.height, 1800 * 2);
    assert.equal(s.scrollTop(), 0);
  });

  test('выбранный body снимает всю страницу, даже если body высотой с экран (html, body { height: 100% })', async () => {
    const env = loadContent({ html: '<div id="c">Контент</div>' });
    const html = env.document.documentElement;
    let scrolled = 0;
    env.window.scrollTo = (o) => (scrolled = Math.min(o.top, 2000));
    Object.defineProperty(env.window, 'scrollY', { get: () => scrolled });
    Object.defineProperty(html, 'scrollHeight', { get: () => 3000, configurable: true });
    env.window.innerHeight = 1000;
    env.window.Element.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 1024, height: 1000, right: 1024, bottom: 1000 };
    };
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(env.document.body);
    env.fire(env.document.body, 'click');
    await env.sleep(1500);
    const captures = env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;
    assert.equal(captures, 3);
    assert.equal(env.api.state.shot.height, 3000 * 2);
    assert.equal(env.api.state.shot.truncated, false);
  });

  test('выбранный body в приложении с внутренней прокруткой: шапка + всё содержимое области', async () => {
    const env = loadContent({ html: '<main id="main" style="overflow-y:auto"><p>Форма</p></main>' });
    const main = env.document.getElementById('main');
    const s = innerScroller(env, main, 1800); // область 60…860 из экрана 1000
    env.window.Element.prototype.getBoundingClientRect = function () {
      return this === main ? s.box : { left: 0, top: 0, width: 1024, height: 1000, right: 1024, bottom: 1000 };
    };
    s.setScrollTop(300);
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    env.pointAt(env.document.body);
    env.fire(env.document.body, 'click');
    await env.sleep(1500);
    const captures = env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;
    assert.equal(captures, 3); // 800 + 800 + 200
    assert.equal(env.api.state.shot.height, (1000 + 1000) * 2); // экран + то, что спрятано в области
    assert.equal(s.scrollTop(), 300);
  });

  test('выбор нативного select снимает его вместе с эмулированным списком и удаляет копию', async () => {
    const env = await formFor('#s', { html: '<select id="s"><option>A</option><option>B</option></select>' });
    assert.equal(env.document.querySelector('[data-udc-select-list]'), null);
    assert.match(env.$('.shot-meta').textContent, /список раскрыт расширением/);
    env.$('[name=newGroup]').value = 'Select';
    env.$('[data-act=save]').click();
    await env.sleep(10);
    const issue = env.chrome.runtime.sendMessage.mock.calls.find((c) => c.arguments[0].type === 'udc:saveIssue').arguments[0].issue;
    assert.match(issue.screenshotNote, /нативный выпадающий список рисует система/);
  });
});

describe('«Переснять» скриншот в форме', () => {
  async function formFor(html) {
    const env = loadContent(html ? { html } : {});
    await env.send({ type: 'udc:start', review: { id: 'rev-1', title: 'Ревью' } });
    const el = env.document.querySelector('#buy, #box');
    env.pointAt(el);
    env.fire(el, 'click');
    await env.sleep(250);
    return { ...env, el };
  }
  const captures = (env) => env.chrome.runtime.sendMessage.mock.calls.filter((c) => c.arguments[0].type === 'udc:capture').length;

  test('снимает тот же элемент заново: новый размер и превью; введённое остаётся', async () => {
    const env = await formFor();
    assert.equal(env.$('.shot-meta').textContent, 'button#buy.btn.primary · 120×40');
    env.$('[name=newGroup]').value = 'Высота блока';
    env.$('[name=note]').value = 'Раскрыли список';
    const before = captures(env);
    const oldCanvas = env.$('.shot canvas');

    env.setRect(env.el, { left: 10, top: 20, width: 120, height: 90 }); // блок на странице вырос
    env.$('[data-act=retake]').click();
    assert.equal(env.$('[data-act=retake]').disabled, true, 'пока снимает — кнопка недоступна');
    await env.sleep(250);

    assert.equal(captures(env), before + 1);
    assert.notEqual(env.$('.shot canvas'), oldCanvas);
    assert.equal(env.shadow().querySelectorAll('.shot canvas').length, 1);
    assert.equal(env.$('.shot-meta').textContent, 'button#buy.btn.primary · 120×90');
    assert.equal(env.$('[data-act=retake]').disabled, false);
    assert.equal(env.$('[name=newGroup]').value, 'Высота блока');
    assert.equal(env.$('[name=note]').value, 'Раскрыли список');

    env.$('[data-act=save]').click();
    await env.sleep(10);
    const issue = env.chrome.runtime.sendMessage.mock.calls.find((c) => c.arguments[0].type === 'udc:saveIssue').arguments[0].issue;
    assert.equal(issue.element.height, 90);
    assert.equal(issue.note, 'Раскрыли список');
    assert.equal(issue.styles.groups.find((g) => g.title === 'Размер').rows.find(([k]) => k === 'height')[1], '90px');
  });

  test('элемент пропал со страницы — ошибка, форма и старый скриншот остаются', async () => {
    const env = await formFor();
    const before = captures(env);
    env.el.remove();
    env.$('[data-act=retake]').click();
    await env.sleep(10);
    assert.equal(captures(env), before);
    assert.match(env.$('.toast').textContent, /Элемента больше нет на странице/);
    assert.equal(env.api.state.mode, 'form');
    assert.ok(env.$('.shot canvas'));
  });

  test('ошибка снимка — уведомление, форма остаётся', async () => {
    const env = await formFor();
    env.chrome.runtime.sendMessage.mock.mockImplementation(async () => ({ ok: false, error: 'нет доступа к вкладке' }));
    env.$('[data-act=retake]').click();
    await env.sleep(250);
    assert.match(env.$('.toast').textContent, /Не удалось переснять: нет доступа к вкладке/);
    assert.equal(env.api.state.mode, 'form');
    assert.equal(env.$('[data-act=retake]').disabled, false);
  });

  test('пока переснимает — сохранить нельзя', async () => {
    const env = await formFor();
    env.$('[name=newGroup]').value = 'x';
    env.$('[data-act=retake]').click();
    env.$('[data-act=save]').click();
    await env.sleep(5);
    assert.ok(!env.chrome.runtime.sendMessage.mock.calls.some((c) => c.arguments[0].type === 'udc:saveIssue'));
    await env.sleep(250);
    env.$('[data-act=save]').click();
    await env.sleep(10);
    assert.ok(env.chrome.runtime.sendMessage.mock.calls.some((c) => c.arguments[0].type === 'udc:saveIssue'));
  });

  test('область переснимается той же рамкой', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const target = env.document.getElementById('buy');
    env.pointAt(target);
    env.fire(target, 'pointerdown', { button: 0, clientX: 10, clientY: 10 });
    env.fire(target, 'pointermove', { clientX: 210, clientY: 110 });
    env.fire(target, 'pointerup', { clientX: 210, clientY: 110 });
    await env.sleep(250);
    const before = env.draws.length;
    env.$('[data-act=retake]').click();
    await env.sleep(250);
    const [, sx, sy, w, h] = env.draws.at(-1);
    assert.equal(env.draws.length, before + 1);
    assert.deepEqual([sx, sy, w, h], [20, 20, 400, 200]);
    assert.equal(env.$('.shot-meta').textContent, 'Область 200×100');
  });
});

describe('снимок области', () => {
  test('протянутая мышью рамка снимает прямоугольник экрана без стилей и атрибутов', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const target = env.document.getElementById('buy');
    env.pointAt(target);
    env.fire(target, 'pointerdown', { button: 0, clientX: 10, clientY: 10 });
    env.fire(target, 'pointermove', { clientX: 210, clientY: 110 });
    assert.ok(env.$('.hl').classList.contains('region'));
    env.fire(target, 'pointerup', { clientX: 210, clientY: 110 });
    await env.sleep(250);
    assert.equal(env.api.state.mode, 'form');
    assert.equal(env.$('.shot-meta').textContent, 'Область 200×100');
    env.$('[name=newGroup]').value = 'Область';
    env.$('[data-act=save]').click();
    await env.sleep(10);
    const issue = env.chrome.runtime.sendMessage.mock.calls.find((c) => c.arguments[0].type === 'udc:saveIssue').arguments[0].issue;
    assert.equal(issue.styles, null);
    assert.equal(issue.element.region, true);
    assert.deepEqual(JSON.parse(JSON.stringify(issue.element.attributes)), {});
    assert.equal(issue.screenshotNote, 'Снимок области экрана');
  });

  test('короткое движение (< 6px) — обычный клик, а не область', async () => {
    const env = loadContent();
    await env.send({ type: 'udc:start', review: { id: 'r', title: 'R' } });
    const target = env.document.getElementById('buy');
    env.pointAt(target);
    env.fire(target, 'pointerdown', { button: 0, clientX: 10, clientY: 10 });
    env.fire(target, 'pointermove', { clientX: 13, clientY: 12 });
    env.fire(target, 'pointerup', { clientX: 13, clientY: 12 });
    assert.equal(env.$('.hl').classList.contains('region'), false);
    assert.equal(env.api.state.mode, 'picking');
  });
});
