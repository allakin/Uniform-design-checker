import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown, renderInline, htmlToMarkdown, sanitizeHtml } from '../../lib/markdown.js';

const { document } = new JSDOM('').window;
const toMd = (html) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return htmlToMarkdown(div);
};
const roundTrip = (md) => toMd(renderMarkdown(md));

describe('renderMarkdown', () => {
  test('простой текст: абзацы и переносы строк как раньше', () => {
    assert.equal(renderMarkdown('Строка 1\nСтрока 2\n\nАбзац'), '<p>Строка 1<br>Строка 2</p><p>Абзац</p>');
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown(null), '');
  });

  test('inline: жирный, курсив, зачёркнутый, код, оба сразу', () => {
    assert.equal(renderInline('**a** _b_ *c* ~~d~~ `e`'), '<strong>a</strong> <em>b</em> <em>c</em> <del>d</del> <code>e</code>');
    assert.equal(renderInline('***x***'), '<strong><em>x</em></strong>');
    assert.equal(renderInline('**_x_**'), '<strong><em>x</em></strong>');
  });

  test('подчёркивания внутри слов (селекторы, имена) — не курсив', () => {
    assert.equal(renderInline('flex_module_0IyLKG a_b_c'), 'flex_module_0IyLKG a_b_c');
    assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4');
  });

  test('код: внутри разметка не работает, HTML экранирован, ``…`` с апострофом внутри', () => {
    assert.equal(renderInline('`**x** <b>`'), '<code>**x** &lt;b&gt;</code>');
    assert.equal(renderInline('`` a`b ``'), '<code>a`b</code>');
    assert.equal(renderMarkdown('```\n<div>\n  **x**\n```'), '<pre><code>&lt;div&gt;\n  **x**</code></pre>');
  });

  test('экранирование обратным слэшем', () => {
    assert.equal(renderInline('\\*не курсив\\* \\`не код\\`'), '*не курсив* `не код`');
  });

  test('ссылки: только http(s), автоссылки без завершающей пунктуации', () => {
    assert.equal(renderInline('[макет](https://figma.com/x)'), '<a href="https://figma.com/x" target="_blank" rel="noopener">макет</a>');
    assert.equal(renderInline('см. https://a.ru/b?c=1.'), 'см. <a href="https://a.ru/b?c=1" target="_blank" rel="noopener">https://a.ru/b?c=1</a>.');
    assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
    assert.equal(renderInline('[x](data:text/html,1)'), '[x](data:text/html,1)');
  });

  test('XSS: любой HTML выводится текстом', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n# <script>x</script>\n- <b onclick=1>');
    const div = document.createElement('div');
    div.innerHTML = html;
    assert.equal(div.querySelectorAll('img, script, b, [onerror], [onclick]').length, 0);
  });

  test('блоки: заголовки, цитата, линия, списки с вложенностью и нумерацией', () => {
    assert.equal(renderMarkdown('# A\n## B\n### C'), '<h1>A</h1><h2>B</h2><h3>C</h3>');
    assert.equal(renderMarkdown('> a\n> b'), '<blockquote><p>a<br>b</p></blockquote>');
    assert.equal(renderMarkdown('---'), '<hr>');
    assert.equal(renderMarkdown('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
    assert.equal(renderMarkdown('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
    assert.equal(renderMarkdown('- a\n  продолжение'), '<ul><li>a<br>продолжение</li></ul>');
  });

  test('чек-лист', () => {
    assert.equal(
      renderMarkdown('- [ ] a\n- [x] b'),
      '<ul class="todos"><li class="todo" data-checked="false">a</li><li class="todo" data-checked="true">b</li></ul>',
    );
  });
});

describe('htmlToMarkdown', () => {
  test('разметка contenteditable: div/p, br, b/i/strike, списки', () => {
    assert.equal(toMd('<div>Первая</div><div><b>жирная</b> и <i>курсив</i> и <strike>нет</strike></div>'), 'Первая\n\n**жирная** и _курсив_ и ~~нет~~');
    assert.equal(toMd('<p>a<br>b</p>'), 'a\nb');
    assert.equal(toMd('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>'), '- a\n  - b\n- c');
    assert.equal(toMd('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
  });

  test('стили вместо тегов (вставка из Google Docs и т.п.)', () => {
    assert.equal(toMd('<span style="font-weight:700">a</span> <span style="font-style:italic">b</span>'), '**a** _b_');
  });

  test('пробелы выносятся за маркеры, пустое форматирование отбрасывается', () => {
    assert.equal(toMd('<p>a<b> b </b>c<i> </i></p>'), 'a **b** c');
  });

  test('спецсимволы текста экранируются, чтобы не стать разметкой', () => {
    assert.equal(toMd('<p>2 * 3 [x] `y`</p>'), '2 \\* 3 \\[x\\] \\`y\\`');
    assert.equal(toMd('<p># не заголовок</p><p>- не список</p><p>1. не нумерация</p><p>&gt; не цитата</p>'), '\\# не заголовок\n\n\\- не список\n\n1\\. не нумерация\n\n\\> не цитата');
    assert.equal(toMd('<p>flex_module_x _a_</p>'), 'flex_module_x \\_a\\_');
  });

  test('ссылки: только безопасные; текст = адрес → автоссылка', () => {
    assert.equal(toMd('<a href="https://a.ru/x">макет</a>'), '[макет](https://a.ru/x)');
    assert.equal(toMd('<a href="https://a.ru/x">https://a.ru/x</a>'), 'https://a.ru/x');
    assert.equal(toMd('<a href="javascript:alert(1)">x</a>'), 'x');
  });

  test('невидимые пробелы редактора и nbsp не попадают в Markdown', () => {
    assert.equal(toMd('<p><code>x</code>​&nbsp;y</p>'), '`x` y');
  });

  test('скрипты, стили, картинки и кнопки отбрасываются', () => {
    assert.equal(toMd('<p>a<script>x</script><style>y</style><img src=z><button>b</button></p>'), 'a');
  });
});

describe('round-trip Markdown → HTML → Markdown', () => {
  const cases = [
    'Просто текст\nвторая строка',
    '**жирный** и _курсив_ и ~~зачёркнутый~~ и `код` и **_оба_**',
    '# Заголовок\n\nАбзац',
    '### Подзаголовок',
    '- один\n- два\n  - вложенный\n- три',
    '1. первый\n2. второй',
    '- [ ] сделать\n- [x] готово',
    '> цитата\n> вторая',
    '```\nconst a = 1 < 2;\n```',
    '```python\nif x > 0:\n\tprint(x)\n```',
    '---',
    'Ссылка [макет](https://figma.com/x) и https://example.com/a?b=1.',
    'a `b` c with \\`tick\\`',
  ];
  for (const md of cases) test(JSON.stringify(md), () => assert.equal(roundTrip(md), md));

  test('свободный текст после одного прохода стабилен', () => {
    for (const md of ['2 * 3 [x] #tag', '<script>x</script> [x](javascript:1)', '***оба***', '- a\n1. b']) {
      const once = roundTrip(md);
      assert.equal(roundTrip(once), once, md);
      assert.equal(renderMarkdown(once), renderMarkdown(md), md);
    }
  });
});

describe('sanitizeHtml (вставка из буфера)', () => {
  test('оставляет форматирование, выбрасывает опасное и лишнее', () => {
    const html = sanitizeHtml('<meta charset=utf-8><h2 style="color:red">T</h2><p onclick="x()"><b>a</b> <a href="javascript:1">b</a> <img src=x onerror=1></p><table><tr><td>c</td></tr></table>', document);
    assert.equal(html, '<h2>T</h2><p><strong>a</strong> b</p><p>c</p>');
  });
});

describe('язык блока кода', () => {
  test('сохраняется в data-lang; опасное имя отбрасывается', () => {
    assert.equal(renderMarkdown('```python\nx\n```'), '<pre data-lang="python"><code>x</code></pre>');
    assert.equal(renderMarkdown('```c++ extra\nx\n```'), '<pre data-lang="c++"><code>x</code></pre>');
    assert.equal(renderMarkdown('```"><img src=x>\nx\n```'), '<pre><code>x</code></pre>');
  });

  test('переносы строк <br> внутри блока кода (так делает редактор) не теряются', () => {
    assert.equal(toMd('<pre data-lang="js">let a;<br>let b;<br><br></pre>'), '```js\nlet a;\nlet b;\n```');
  });
});
