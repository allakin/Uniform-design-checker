import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeIssue, makeReview, makeGroup, PNG, JPEG } from '../helpers/env.js';
import {
  escapeHtml,
  formatDate,
  reportFileName,
  buildReportBody,
  buildReportDocument,
  lightboxIcons,
  installLightbox,
  installToc,
  REPORT_CSS,
  LIGHTBOX_CSS,
} from '../../lib/report.js';
import { ICONS } from '../../lib/icons.js';

const XSS = `<img src=x onerror="alert('x')">&`;
const parse = (html) => new JSDOM(html).window.document;
const bodyDoc = (review) => parse(`<!doctype html><body>${buildReportBody(review)}</body>`);

describe('escapeHtml', () => {
  test('экранирует все спецсимволы HTML', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  test('null/undefined → пустая строка, числа → строка', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });
  test('не экранирует повторно безопасный текст', () => {
    assert.equal(escapeHtml('Кнопка — 12px'), 'Кнопка — 12px');
  });
});

describe('formatDate', () => {
  test('формат ДД.ММ.ГГГГ, ЧЧ:ММ', () => {
    assert.match(formatDate(Date.UTC(2026, 9, 16, 12, 5)), /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
  });
});

describe('reportFileName', () => {
  test('имя с названием, сегодняшней датой и расширением', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(reportFileName({ title: 'Оплата' }, 'html'), `Единообразие блоков — Оплата — ${today}.html`);
    assert.ok(reportFileName({ title: 'x' }, 'pdf').endsWith('.pdf'));
  });
  test('убирает символы, запрещённые в именах файлов', () => {
    const name = reportFileName({ title: 'a/b\\c:d*e?f"g<h>i|j' }, 'html');
    assert.ok(!/[\\/:*?"<>|]/.test(name.replace(/\.html$/, '')), name);
  });
  test('пустое название → «review», длинное обрезается до 80 символов', () => {
    assert.match(reportFileName({ title: '' }, 'html'), /^Единообразие блоков — review — /);
    const long = reportFileName({ title: 'я'.repeat(200) }, 'html');
    assert.ok(long.includes('я'.repeat(80)) && !long.includes('я'.repeat(81)));
  });
});

describe('buildReportBody', () => {
  test('шапка: название, число групп и вариантов со склонением', () => {
    for (const [groups, variants, text] of [
      [0, 0, 'групп · 0 вариантов'],
      [1, 1, 'группа · 1 вариант'],
      [2, 3, 'группы · 3 варианта'],
      [5, 5, 'групп · 5 вариантов'],
      [21, 22, 'группа · 22 варианта'],
      [11, 12, 'групп · 12 вариантов'],
    ]) {
      const issues = Array.from({ length: variants }, (_, k) => makeIssue({ group: `Г${k % groups}` }));
      const doc = bodyDoc(makeReview({ issues, groups: Array.from({ length: groups }, (_, k) => makeGroup(`Г${k}`)) }));
      assert.equal(doc.querySelector('.r-total b').textContent, String(groups));
      assert.equal(doc.querySelector('.r-total span').textContent, text, `${groups}/${variants}`);
    }
  });

  test('пустое ревью — заглушка без сводки', () => {
    const doc = bodyDoc(makeReview());
    assert.match(doc.querySelector('.empty-state').textContent, /пока нет снятых блоков/);
    assert.equal(doc.querySelector('table.toc'), null);
  });

  test('сводка: группы с якорями, числом вариантов и страниц', () => {
    const issues = [
      makeIssue({ group: 'Кнопка', page: { url: 'https://shop.ru/a' } }),
      makeIssue({ group: 'Кнопка', page: { url: 'https://shop.ru/b?x=1' } }),
      makeIssue({ group: 'Кнопка', page: { url: 'https://shop.ru/b?x=2' } }),
      makeIssue({ group: 'Модалка' }),
      makeIssue({ group: 'Модалка' }),
      makeIssue({ group: 'Шапка' }),
    ];
    const doc = bodyDoc(makeReview({ issues }));
    const rows = [...doc.querySelectorAll('table.toc tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent));
    assert.deepEqual(rows, [
      ['1', 'Кнопка', '3', '2'],
      ['2', 'Модалка', '2', '1'],
      ['3', 'Шапка', '1', '1'],
    ]);
    doc.querySelectorAll('table.toc a').forEach((a, k) => {
      assert.equal(a.getAttribute('href'), `#group-${k + 1}`);
      assert.ok(doc.getElementById(`group-${k + 1}`));
    });
    assert.equal(doc.getElementById('group-1').className, 'group', 'без цветной пометки');
  });

  test('автор в шапке необязателен', () => {
    assert.match(bodyDoc(makeReview({ author: 'Анна' })).querySelector('.r-meta').textContent, /Автор: Анна/);
    assert.doesNotMatch(bodyDoc(makeReview({ author: '' })).querySelector('.r-meta').textContent, /Автор/);
  });

  test('тикеты: кликабельные ссылки или «не указан»', () => {
    const doc = bodyDoc(makeReview({ devTicketUrl: 'https://st.example.com/DEV-1/', designTicketUrl: '' }));
    const [dev, design] = doc.querySelectorAll('.r-tasks > *');
    assert.equal(dev.tagName, 'A');
    assert.equal(dev.getAttribute('href'), 'https://st.example.com/DEV-1/');
    assert.equal(dev.querySelector('.task-link').textContent, 'st.example.com/DEV-1');
    assert.equal(design.tagName, 'DIV');
    assert.ok(design.classList.contains('empty'));
    assert.equal(design.querySelector('.task-link').textContent, 'не указан');
  });

  test('навигация «В этом отчёте»: сводка и все группы со ссылками на якоря', () => {
    const issues = [makeIssue({ group: 'Отступ' }), makeIssue({ group: XSS })];
    const doc = bodyDoc(makeReview({ issues }));
    const nav = doc.querySelector('.r-layout > nav.r-nav');
    assert.ok(nav);
    assert.equal(nav.querySelector('.r-nav-title').textContent, 'В этом отчёте:');
    const links = [...nav.querySelectorAll('a')];
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#summary', '#groups', '#group-1', '#group-2']);
    for (const a of links) assert.ok(doc.getElementById(a.getAttribute('href').slice(1)), a.getAttribute('href'));
    assert.equal(links[2].textContent, '#1 Отступ');
    assert.equal(links[3].textContent, `#2 ${XSS}`);
    assert.equal(nav.querySelector('img'), null);
  });

  test('пустое ревью — без навигации', () => {
    assert.equal(bodyDoc(makeReview()).querySelector('.r-nav'), null);
  });

  test('карточка группы: название, число вариантов и страниц, описание, макет', () => {
    const issues = [makeIssue({ group: 'Кнопка' }), makeIssue({ group: 'Кнопка', page: { url: 'https://example.com/other' } })];
    const review = makeReview({ issues });
    Object.assign(review.groups[0], { description: 'Строка 1\nСтрока 2', mockupUrl: 'https://www.figma.com/file/abc' });
    const card = bodyDoc(review).getElementById('group-1');
    assert.equal(card.querySelector('h3').textContent, 'Кнопка');
    assert.equal(card.querySelector('.group-sub').textContent, '2 варианта · 2 страницы');
    const desc = card.querySelector('.g-desc');
    assert.equal(desc.querySelector('.v-label').textContent, 'Описание');
    assert.equal(desc.querySelector('.desc').innerHTML, '<p>Строка 1<br>Строка 2</p>');
    const mockup = card.querySelector('a.v-link.mockup');
    assert.equal(mockup.getAttribute('href'), 'https://www.figma.com/file/abc');
    assert.equal(mockup.getAttribute('rel'), 'noopener');
    assert.equal(mockup.getAttribute('title'), 'Открыть в Figma\nhttps://www.figma.com/file/abc', 'полный адрес — в подсказке');
    assert.equal(mockup.querySelector('.v-label').textContent, 'Макет');
    assert.equal(mockup.querySelector('.v-title').textContent, 'Открыть в Figma', 'название, а не адрес');
  });

  test('без описания и макета этих блоков нет; пустая группа — заглушка', () => {
    const doc = bodyDoc(makeReview({ issues: [makeIssue({ group: 'Кнопка' })], groups: [makeGroup('Кнопка'), makeGroup('Пустая')] }));
    assert.equal(doc.querySelector('#group-1 .g-info'), null);
    assert.doesNotMatch(doc.getElementById('group-1').textContent, /Макет/);
    assert.match(doc.getElementById('group-2').textContent, /В группе пока нет вариантов/);
  });

  test('вариант: ссылка на страницу, где он снят, и заметка; без селектора, стилей, окна и даты', () => {
    const issue = makeIssue({ note: 'Радиус 4px вместо 8px', page: { url: 'https://shop.ru/cart/?utm=1', title: 'Корзина' } });
    const v = bodyDoc(makeReview({ issues: [issue] })).querySelector('#group-1 .variant');
    assert.equal(v.querySelector('.variant-head').textContent, 'Вариант 1');
    const page = v.querySelector('a.v-link.page');
    assert.equal(page.getAttribute('href'), 'https://shop.ru/cart/?utm=1');
    assert.equal(page.getAttribute('target'), '_blank');
    assert.equal(page.querySelector('.v-label').textContent, 'Страница');
    assert.equal(page.querySelector('.v-title').textContent, 'Корзина');
    assert.equal(page.querySelector('small'), null, 'адрес на карточке не выводится');
    assert.doesNotMatch(page.textContent, /shop\.ru/);
    assert.equal(page.getAttribute('title'), 'Корзина\nhttps://shop.ru/cart/?utm=1', 'полные заголовок и адрес — в подсказке');
    assert.match(REPORT_CSS, /\.v-title \{[^}]*text-overflow: ellipsis; white-space: nowrap;/, 'заголовок в одну строку — карточки одной высоты');
    assert.equal(v.querySelector('.note .v-label').textContent, 'Заметка');
    assert.equal(v.querySelector('.note p').textContent, 'Радиус 4px вместо 8px');
    assert.equal(v.querySelector('.v-meta'), null);
    assert.doesNotMatch(v.textContent, /Окно|Снято|DPR/);
    assert.doesNotMatch(v.textContent, /Элемент|main > \.card/);
    assert.equal(v.querySelector('details.specs'), null);
  });

  test('вариант без страницы и заметки', () => {
    const v = bodyDoc(makeReview({ issues: [makeIssue({ page: null, element: null, viewport: null })] })).querySelector('.variant');
    assert.equal(v.querySelector('.page').textContent, 'Страница не указана');
    assert.equal(v.querySelector('.note'), null);
  });

  test('варианты без своей группы попадают в «Без группы»', () => {
    const lost = { ...makeIssue(), groupId: 'gone' };
    const doc = bodyDoc(makeReview({ issues: [lost], groups: [] }));
    assert.equal(doc.querySelector('#group-1 h3').textContent, 'Без группы');
  });

  test('скриншот: только data:image/png|jpeg, с подписью и пометками', () => {
    const doc = bodyDoc(
      makeReview({
        issues: [
          makeIssue({ screenshot: PNG, screenshotTruncated: true, screenshotNote: 'Снимок области экрана' }),
          makeIssue({ screenshot: JPEG }),
          makeIssue({ screenshot: 'https://evil.example/x.png' }),
          makeIssue({ screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' }),
          makeIssue({ screenshot: '' }),
        ],
      }),
    );
    const imgs = doc.querySelectorAll('.shot img');
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0].getAttribute('data-caption'), 'Кнопка удаления · вариант 1 · Каталог');
    const notes = [...doc.querySelectorAll('.variant')[0].querySelectorAll('.shot-note')].map((n) => n.textContent);
    assert.deepEqual(notes, ['Блок слишком большой — снят не целиком', 'Снимок области экрана']);
  });

  test('XSS: пользовательские данные экранированы, опасные ссылки отброшены', () => {
    const review = makeReview({
      title: XSS,
      author: XSS,
      devTicketUrl: 'javascript:alert(1)',
      designTicketUrl: 'data:text/html,<script>1</script>',
      issues: [
        makeIssue({
          group: XSS,
          note: XSS,
          page: { url: 'javascript:alert(2)', title: XSS },
          element: { selector: XSS, width: 1, height: 1, attributes: { [XSS]: XSS } },
          screenshotNote: XSS,
          styles: { groups: [{ title: XSS, rows: [[XSS, XSS]] }] },
        }),
      ],
    });
    review.groups[0].description = XSS;
    review.groups[0].mockupUrl = 'javascript:alert(1)';
    const doc = bodyDoc(review);
    assert.equal(doc.querySelectorAll('img[onerror], script').length, 0);
    assert.equal(doc.querySelectorAll('a[href^="javascript"], a[href^="data"]').length, 0);
    assert.equal(doc.querySelectorAll('.r-tasks .task.empty').length, 2);
    assert.equal(doc.querySelector('h1').textContent, XSS);
    assert.equal(doc.querySelector('.group h3').textContent, XSS);
  });
});

describe('сравнение стилей убрано', () => {
  test('в отчёте нет таблицы различий и блока «Чем отличаются варианты»', () => {
    const styled = (color) => makeIssue({ styles: { groups: [{ title: 'Цвета', rows: [['color', color]] }] } });
    const doc = bodyDoc(makeReview({ issues: [styled('#1'), styled('#2')] }));
    assert.equal(doc.querySelector('table.diff'), null);
    assert.doesNotMatch(doc.body.textContent, /Чем отличаются|Различий/);
    assert.deepEqual([...doc.querySelectorAll('#group-1 .i-label')].map((l) => l.textContent), ['Варианты 2']);
  });

  test('в PDF варианты по два в ряд', () => {
    assert.match(REPORT_CSS.slice(REPORT_CSS.indexOf('@media print')), /\.variants \{ grid-template-columns: 1fr 1fr; \}/);
  });
});

describe('buildReportDocument', () => {
  test('полноценный HTML-документ с заголовком, стилями и скриптом просмотрщика', () => {
    const review = makeReview({ title: 'Оплата', issues: [makeIssue()] });
    const html = buildReportDocument(review);
    assert.match(html, /^<!doctype html>/);
    const doc = parse(html);
    assert.equal(doc.documentElement.lang, 'ru');
    assert.equal(doc.title, 'Единообразие блоков — Оплата');
    assert.ok(doc.querySelector('meta[charset="utf-8"]'));
    assert.ok(doc.querySelector('style').textContent.includes('.variant'));
    assert.equal(doc.querySelectorAll('script').length, 1);
    assert.ok(doc.querySelector('main.report'));
  });

  test('самодостаточный: никаких внешних ресурсов', () => {
    const html = buildReportDocument(makeReview({ issues: [makeIssue()] }));
    const doc = parse(html);
    assert.equal(doc.querySelectorAll('link[rel=stylesheet], script[src], img[src^=http]').length, 0);
    assert.doesNotMatch(html, /@import|url\(https?:/);
  });

  test('заголовок документа экранирован', () => {
    const doc = parse(buildReportDocument(makeReview({ title: '</title><script>alert(1)</script>' })));
    assert.equal(doc.querySelectorAll('script').length, 1);
    assert.match(doc.title, /<\/title>/);
  });

  test('встроенные иконки не могут закрыть тег <script>', () => {
    const html = buildReportDocument(makeReview());
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    assert.doesNotMatch(script, /<\/script/i);
    assert.doesNotMatch(script.slice(script.indexOf('(document, ')), /</);
  });

  test('скрипт просмотрщика исполняется в открытом с диска файле', () => {
    const dom = new JSDOM(buildReportDocument(makeReview({ issues: [makeIssue()] })), { runScripts: 'dangerously', pretendToBeVisual: true });
    assert.ok(dom.window.document.querySelector('.lb[hidden]'));
    dom.window.close();
  });
});

describe('стили', () => {
  test('REPORT_CSS включает стили просмотрщика и печати', () => {
    assert.ok(REPORT_CSS.includes(LIGHTBOX_CSS));
    assert.match(REPORT_CSS, /@media print/);
    assert.match(REPORT_CSS, /@page \{ size: A4/);
  });

  test('подписи блоков группы — как в тексте, без капса', () => {
    const rule = REPORT_CSS.match(/\.i-label \{[^}]*\}/)[0];
    assert.doesNotMatch(rule, /text-transform/);
  });

  test('строки свойств варианта разнесены, значения не слипаются', () => {
    assert.match(REPORT_CSS, /dl\.props \{[^}]*gap: 6px 12px;/);
  });

  test('навигация только на широком экране и не попадает в PDF', () => {
    assert.match(REPORT_CSS, /@media \(max-width: 1180px\) \{ \.r-nav \{ display: none; \} \}/);
    assert.match(REPORT_CSS.slice(REPORT_CSS.indexOf('@media print')), /\.r-nav \{ display: none !important; \}|\.r-nav[^{]*\{ display: none !important/);
  });
});

describe('installToc (навигация «В этом отчёте»)', () => {
  function setup(n = 3) {
    const review = makeReview({ issues: Array.from({ length: n }, (_, k) => makeIssue({ group: `Группа ${k + 1}` })) });
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(review)}</body>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    installToc(doc);
    const active = () => [...doc.querySelectorAll('.r-nav a.active')].map((a) => a.getAttribute('href'));
    return { dom, doc, active };
  }

  test('сразу подсвечен один пункт', () => {
    const { dom, doc, active } = setup();
    assert.equal(active().length, 1);
    assert.equal(doc.querySelector('.r-nav a.active').getAttribute('aria-current'), 'true');
    dom.window.close();
  });

  test('клик по пункту делает его активным, прежний гаснет', () => {
    const { dom, doc, active } = setup();
    const before = doc.querySelector('.r-nav a.active');
    doc.querySelector('.r-nav a[href="#group-1"]').click();
    assert.deepEqual(active(), ['#group-1']);
    assert.equal(before.getAttribute('aria-current'), null);
    dom.window.close();
  });

  test('возвращает функцию, которая снимает обработчики окна', () => {
    const { dom, doc } = setup();
    const win = dom.window;
    const removed = [];
    const original = win.removeEventListener.bind(win);
    win.removeEventListener = (type, fn) => (removed.push(type), original(type, fn));
    const dispose = installToc(doc);
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.deepEqual(removed.sort(), ['resize', 'scroll', 'scrollend']);
    dom.window.close();
  });

  test('без навигации (пустое ревью) не падает', () => {
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(makeReview())}</body>`);
    assert.doesNotThrow(() => installToc(dom.window.document));
  });

  test('работает в скачанном файле, открытом с диска', () => {
    const dom = new JSDOM(buildReportDocument(makeReview({ issues: [makeIssue(), makeIssue()] })), { runScripts: 'dangerously', pretendToBeVisual: true });
    assert.equal(dom.window.document.querySelectorAll('.r-nav a.active').length, 1);
    dom.window.close();
  });
});

describe('lightboxIcons', () => {
  test('все нужные просмотрщику иконки существуют', () => {
    const icons = lightboxIcons();
    assert.deepEqual(Object.keys(icons).sort(), ['chevronLeft', 'chevronRight', 'expand', 'xmark', 'zoomIn', 'zoomOut']);
    for (const [name, svg] of Object.entries(icons)) assert.equal(svg, ICONS[name], name);
  });
});

describe('installLightbox (просмотр скриншотов)', () => {
  function setup(n = 3) {
    const review = makeReview({ issues: Array.from({ length: n }, () => makeIssue()) });
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(review)}</body>`, { pretendToBeVisual: true });
    const { document: doc } = dom.window;
    installLightbox(doc, lightboxIcons());
    const box = doc.querySelector('.lb');
    const imgs = [...doc.querySelectorAll('.report .shot img')];
    const key = (k) => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return { dom, doc, box, imgs, key, click, review };
  }

  test('изначально скрыт', () => {
    const { box } = setup();
    assert.equal(box.hidden, true);
  });

  test('клик по скриншоту открывает его с подписью и счётчиком', () => {
    const { doc, box, imgs, click, review } = setup();
    click(imgs[1]);
    assert.equal(box.hidden, false);
    assert.ok(doc.documentElement.classList.contains('lb-open'));
    assert.equal(box.querySelector('.lb-cap').textContent, 'Кнопка удаления · вариант 2 · Каталог');
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
    assert.equal(box.querySelector('.lb-stage img').src, imgs[1].src);
  });

  test('стрелки листают по кругу', () => {
    const { box, imgs, click, key } = setup();
    click(imgs[0]);
    key('ArrowLeft');
    assert.equal(box.querySelector('.lb-count').textContent, '3 / 3');
    key('ArrowRight');
    key('ArrowRight');
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
  });

  test('кнопки ‹ › работают как стрелки', () => {
    const { box, imgs, click } = setup();
    click(imgs[0]);
    click(box.querySelector('[data-lb=next]'));
    assert.equal(box.querySelector('.lb-count').textContent, '2 / 3');
    click(box.querySelector('[data-lb=prev]'));
    assert.equal(box.querySelector('.lb-count').textContent, '1 / 3');
  });

  test('Z и кнопка масштаба переключают «вписать» / «100%» (и в русской раскладке)', () => {
    const { box, imgs, click, key } = setup();
    click(imgs[0]);
    assert.equal(box.classList.contains('actual'), false);
    key('z');
    assert.equal(box.classList.contains('actual'), true);
    assert.match(box.querySelector('[data-lb=zoom]').textContent, /Вписать/);
    key('я');
    assert.equal(box.classList.contains('actual'), false);
    click(box.querySelector('[data-lb=zoom]'));
    assert.equal(box.classList.contains('actual'), true);
    click(box.querySelector('.lb-stage img'));
    assert.equal(box.classList.contains('actual'), false);
  });

  test('Esc, крестик и клик по фону закрывают', () => {
    const { doc, box, imgs, click, key } = setup();
    click(imgs[0]);
    key('Escape');
    assert.equal(box.hidden, true);
    assert.equal(doc.documentElement.classList.contains('lb-open'), false);
    click(imgs[0]);
    click(box.querySelector('[data-lb=close]'));
    assert.equal(box.hidden, true);
    click(imgs[0]);
    click(box.querySelector('.lb-stage'));
    assert.equal(box.hidden, true);
  });

  test('с одним скриншотом навигация скрыта, счётчика нет', () => {
    const { box, imgs, click } = setup(1);
    click(imgs[0]);
    assert.equal(box.querySelector('.lb-count').textContent, '');
    box.querySelectorAll('.lb-nav').forEach((b) => assert.equal(b.hidden, true));
  });

  test('клавиши не перехватываются, пока просмотрщик закрыт', () => {
    const { doc, dom } = setup();
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
    doc.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
  });

  test('работает без иконок (ic = undefined)', () => {
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(makeReview({ issues: [makeIssue()] }))}</body>`);
    assert.doesNotThrow(() => installLightbox(dom.window.document));
  });
});

describe('просмотрщик в отчёте листает варианты своей группы', () => {
  test('стрелки ходят по вариантам одной группы; другая группа — отдельно', () => {
    const review = makeReview({ issues: [makeIssue({ group: 'А' }), makeIssue({ group: 'А', screenshot: JPEG }), makeIssue({ group: 'А' }), makeIssue({ group: 'Б' })] });
    const dom = new JSDOM(`<!doctype html><body>${buildReportBody(review)}</body>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    installLightbox(doc, lightboxIcons());
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const key = (k) => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const box = doc.querySelector('.lb');
    const count = () => box.querySelector('.lb-count').textContent;

    click(doc.querySelectorAll('#group-1 .shot img')[1]);
    assert.equal(count(), '2 / 3');
    assert.equal(box.querySelector('.lb-cap').textContent, 'А · вариант 2 · Каталог');
    key('ArrowRight');
    key('ArrowRight');
    assert.equal(count(), '1 / 3', 'по кругу внутри группы');
    key('Escape');

    click(doc.querySelector('#group-2 .shot img'));
    assert.equal(count(), '', 'один вариант — без счётчика');
    assert.ok(box.querySelector('.lb-nav').hidden);
  });
});

describe('описание в Markdown', () => {
  test('описание группы форматируется в отчёте: заголовки, списки, чек-лист, код, ссылки', () => {
    const md = '### Что не так\n\n**Отступ** _слева_ ~~12px~~ `16px`\n\n- раз\n  - вложенный\n1. первый\n\n- [x] готово\n\n> цитата\n\n[Макет](https://figma.com/x)';
    const review = makeReview({ issues: [makeIssue()] });
    review.groups[0].description = md;
    const card = bodyDoc(review).querySelector('section.group');
    const desc = card.querySelector('.desc.md');
    assert.equal(desc.querySelector('h3').textContent, 'Что не так');
    assert.equal(desc.querySelector('strong').textContent, 'Отступ');
    assert.equal(desc.querySelector('em').textContent, 'слева');
    assert.equal(desc.querySelector('del').textContent, '12px');
    assert.equal(desc.querySelector('code').textContent, '16px');
    assert.equal(desc.querySelector('ul > li > ul > li').textContent, 'вложенный');
    assert.equal(desc.querySelector('ol > li').textContent, 'первый');
    assert.equal(desc.querySelector('ul.todos li.todo').dataset.checked, 'true');
    assert.equal(desc.querySelector('blockquote').textContent, 'цитата');
    assert.equal(desc.querySelector('a').href, 'https://figma.com/x');
    assert.equal(desc.querySelector('a').target, '_blank');
  });

  test('стили описания есть и на экране, и в печати', () => {
    assert.match(REPORT_CSS, /\.md li\.todo::before/);
    assert.match(REPORT_CSS, /\.md pre \{[^}]*white-space: pre-wrap/);
  });
});
