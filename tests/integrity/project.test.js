// Проверки целостности расширения: манифест, пути, синхронность копий, синтаксис.
// Ловят «забыли файл», «переименовали и не поправили ссылку», «поменяли копию только в одном месте».
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ICONS } from '../../lib/icons.js';
import { SUITES, badgesMarkdown, endpointBadge, replaceBlock, repoSlug } from '../../scripts/badges.js';
import { HEADER, touchesExtension } from '../../scripts/changelog-prepend.js';

const ROOT = new URL('../../', import.meta.url);
const path = (p) => new URL(p, ROOT);
const read = (p) => readFileSync(path(p), 'utf8');
const exists = (p) => existsSync(path(p));
const manifest = JSON.parse(read('manifest.json'));

// Все JS-файлы расширения (без тестов и зависимостей).
const SOURCE_DIRS = ['.', 'lib', 'content', 'popup', 'pages'];
const jsFiles = SOURCE_DIRS.flatMap((dir) =>
  readdirSync(path(dir === '.' ? './' : `${dir}/`))
    .filter((f) => f.endsWith('.js'))
    .map((f) => (dir === '.' ? f : `${dir}/${f}`)),
);
const htmlFiles = ['popup/popup.html', 'pages/review.html', 'pages/report.html', 'pages/setup.html'];

describe('manifest.json', () => {
  test('Manifest V3 с обязательными полями', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.description.trim());
  });

  // Распакованное расширение загрузится, но Chrome Web Store отклонит описание длиннее 132 символов.
  test('описание не длиннее 132 символов (лимит Chrome Web Store)', () => {
    assert.ok(manifest.description.length <= 132, `${manifest.description.length} символов`);
  });

  test('версия в manifest.json, package.json и package-lock.json совпадает', () => {
    assert.equal(JSON.parse(read('package.json')).version, manifest.version);
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.version, manifest.version, 'package-lock.json');
    assert.equal(lock.packages[''].version, manifest.version, 'package-lock.json → packages[""]');
  });

  test('все файлы, на которые ссылается манифест, существуют', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const f of files) assert.ok(exists(f), f);
  });

  test('правки всех файлов, которые грузит манифест, требуют нового релиза (EXTENSION_PATHS)', () => {
    const files = ['manifest.json', manifest.background.service_worker, manifest.action.default_popup, 'content/content.js', ...Object.values(manifest.icons)];
    for (const f of files) assert.ok(touchesExtension([f]), `${f} не входит в EXTENSION_PATHS в scripts/changelog-prepend.js`);
  });

  test('иконки — PNG нужных размеров', () => {
    for (const [size, file] of Object.entries(manifest.icons)) {
      const buf = readFileSync(path(file));
      assert.equal(buf.toString('ascii', 1, 4), 'PNG', file);
      assert.equal(buf.readUInt32BE(16), Number(size), `${file}: ширина`);
      assert.equal(buf.readUInt32BE(20), Number(size), `${file}: высота`);
    }
  });

  test('сервис-воркер — ES-модуль', () => {
    assert.equal(manifest.background.type, 'module');
  });

  test('разрешения: всё нужное и ничего лишнего', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage', 'tabs', 'unlimitedStorage']);
    assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  });

  test('горячая клавиша Alt+Shift+D для выбора элемента', () => {
    const cmd = manifest.commands['start-pick'];
    assert.equal(cmd.suggested_key.default, 'Alt+Shift+D');
    assert.equal(cmd.suggested_key.mac, 'Alt+Shift+D');
  });

  test('имя команды совпадает с тем, что слушают background и popup', () => {
    for (const f of ['background.js', 'popup/popup.js', 'pages/setup.js']) assert.ok(read(f).includes("'start-pick'"), f);
  });

  test('в корне нет файлов на «_» — Chrome откажется загружать расширение', () => {
    const bad = readdirSync(path('./')).filter((f) => f.startsWith('_'));
    assert.deepEqual(bad, []);
  });
});

describe('скрипты и страницы', () => {
  test('все JS-файлы синтаксически корректны', () => {
    for (const f of jsFiles) {
      const isModule = !f.startsWith('content/');
      execFileSync(process.execPath, ['--check', ...(isModule ? ['--input-type=module'] : []), ...(isModule ? [] : [fileURLToPath(path(f))])], {
        input: isModule ? read(f) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  });

  test('относительные импорты указывают на существующие файлы и экспортируемые имена', async () => {
    for (const f of jsFiles.filter((x) => !x.startsWith('content/'))) {
      const src = read(f);
      for (const m of src.matchAll(/import\s+(?:\{([^}]+)\}|\*\s+as\s+\w+)\s+from\s+'([^']+)'/g)) {
        const target = new URL(m[2], path(f));
        assert.ok(existsSync(target), `${f}: ${m[2]}`);
        if (!m[1]) continue;
        const exported = readFileSync(target, 'utf8');
        for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          assert.match(exported, new RegExp(`export (async )?(function|const|let|class) ${name}\\b`), `${f}: ${name} из ${m[2]}`);
        }
      }
    }
  });

  test('HTML-страницы подключают существующие скрипты и стили', () => {
    for (const f of htmlFiles) {
      const doc = new JSDOM(read(f)).window.document;
      const refs = [...doc.querySelectorAll('script[src], link[rel=stylesheet], img[src]')].map((n) => n.getAttribute('src') || n.getAttribute('href'));
      assert.ok(refs.length, f);
      for (const ref of refs) assert.ok(existsSync(new URL(ref, path(f))), `${f}: ${ref}`);
      for (const s of doc.querySelectorAll('script[src]')) assert.equal(s.type, 'module', `${f}: ${s.getAttribute('src')} должен быть type=module`);
    }
  });

  test('страницы-вкладки показывают фавиконку расширения с версией в адресе (иначе браузер берёт старую из кэша)', () => {
    for (const f of ['pages/review.html', 'pages/report.html', 'pages/setup.html']) {
      const href = new JSDOM(read(f)).window.document.querySelector('link[rel=icon]')?.getAttribute('href');
      assert.match(href || '', /^\.\.\/icons\/icon32\.png\?v=\d+$/, f);
      assert.ok(existsSync(new URL(href.split('?')[0], path(f))), `${f}: ${href}`);
    }
  });

  test('страницы расширения не грузят ничего из сети (CSP MV3)', () => {
    for (const f of htmlFiles) assert.doesNotMatch(read(f), /(src|href)="https?:/, f);
    // fetch разрешён только для собственных файлов расширения (chrome.runtime.getURL) — это не сеть.
    for (const f of jsFiles) assert.doesNotMatch(read(f), /\bfetch\((?!chrome\.runtime\.getURL\()|XMLHttpRequest|import\(['"]https?:/, f);
  });

  test('нет inline-скриптов (запрещены CSP расширений)', () => {
    for (const f of htmlFiles) {
      const doc = new JSDOM(read(f)).window.document;
      for (const s of doc.querySelectorAll('script:not([src])')) assert.equal(s.textContent.trim(), '', f);
      assert.doesNotMatch(read(f), /\son[a-z]+="/, `${f}: inline-обработчики событий`);
    }
  });

  test('элементы, которые скрипты ищут по id, есть в разметке', () => {
    const pairs = [
      ['popup/popup.js', 'popup/popup.html'],
      ['pages/review.js', 'pages/review.html'],
      ['pages/report.js', 'pages/report.html'],
      ['pages/setup.js', 'pages/setup.html'],
    ];
    for (const [js, html] of pairs) {
      const doc = new JSDOM(read(html)).window.document;
      for (const [, id] of read(js).matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(doc.getElementById(id), `${html}: нет #${id} для ${js}`);
    }
  });

  test('background внедряет существующие файлы в правильном порядке (иконки до content.js)', () => {
    const m = read('background.js').match(/files: \[([^\]]+)\]/);
    const files = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(files, ['content/icons.js', 'content/content.js']);
    files.forEach((f) => assert.ok(exists(f), f));
  });

  // Форма на сайте самодостаточна: файлы расширения сайтам не открыты — по ним сайт мог бы узнать, что расширение установлено.
  test('контент-скрипт не подгружает модули расширения, web_accessible_resources нет', () => {
    assert.doesNotMatch(read('content/content.js'), /\bimport\(/);
    assert.equal(manifest.web_accessible_resources, undefined);
  });

  test('страницы, которые открывает код, существуют', () => {
    for (const f of jsFiles) {
      for (const [, page] of read(f).matchAll(/'(pages\/[\w-]+\.html)/g)) assert.ok(exists(page), `${f}: ${page}`);
      for (const [, page] of read(f).matchAll(/`(pages\/[\w-]+\.html)/g)) assert.ok(exists(page), `${f}: ${page}`);
    }
  });
});

describe('сообщения между частями расширения', () => {
  const handled = new Set([...read('background.js').matchAll(/case '(udc:[\w]+)'/g)].map((m) => m[1]));
  const contentHandles = new Set([...read('content/content.js').matchAll(/msg\?\.type === '(udc:\w+)'/g)].map((m) => m[1]));

  test('всё, что шлют popup и контент-скрипт в runtime, обрабатывает background', () => {
    for (const f of ['popup/popup.js', 'content/content.js', 'pages/review.js']) {
      for (const [, type] of read(f).matchAll(/runtime\.sendMessage\(\{ type: '(udc:\w+)'/g)) assert.ok(handled.has(type), `${f}: ${type}`);
    }
  });

  test('всё, что background шлёт во вкладку, обрабатывает контент-скрипт', () => {
    for (const [, type] of read('background.js').matchAll(/tabs\.sendMessage\(tabId, \{ type: '(udc:\w+)'/g)) assert.ok(contentHandles.has(type), type);
    assert.deepEqual([...contentHandles].sort(), ['udc:ping', 'udc:start']);
  });
});

describe('иконки Gravity UI', () => {
  const contentIcons = (() => {
    const ctx = {};
    new Function('globalThis', read('content/icons.js'))(ctx);
    return ctx.__udcIcons;
  })();

  test('копия иконок для контент-скрипта совпадает с lib/icons.js', () => {
    for (const [name, svg] of Object.entries(contentIcons)) assert.equal(svg, ICONS[name], name);
  });

  test('все icon(...) на страницах расширения существуют', () => {
    for (const f of jsFiles.filter((x) => !x.startsWith('content/'))) {
      for (const [, name] of read(f).matchAll(/\bicon\('(\w+)'/g)) assert.ok(ICONS[name], `${f}: icon('${name}')`);
    }
  });

  test('все I(...) в контент-скрипте существуют в content/icons.js', () => {
    const used = [...read('content/content.js').matchAll(/\bI\('(\w+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 5);
    for (const name of used) assert.ok(contentIcons[name], `I('${name}')`);
  });

  test('иконки — корректные SVG path с currentColor', () => {
    for (const [name, svg] of Object.entries(ICONS)) {
      assert.match(svg, /^<path [^>]*fill="currentColor"[^>]*\/>$/, name);
    }
  });

  test('лицензия иконок лежит рядом', () => {
    assert.match(read('icons/gravity-ui-LICENSE.txt'), /MIT/);
  });
});

describe('репозиторий', () => {
  test('uniform-reviews-results хранится через .gitkeep, содержимое игнорируется', () => {
    const gi = read('.gitignore');
    assert.ok(exists('uniform-reviews-results/.gitkeep'));
    assert.match(gi, /^uniform-reviews-results\/\*$/m);
    assert.match(gi, /^!uniform-reviews-results\/\.gitkeep$/m);
  });

  test('node_modules не попадает в git', () => {
    assert.match(read('.gitignore'), /^node_modules\/?$/m);
  });

  test('раздел «Структура» в README описывает существующие файлы', () => {
    const readme = read('README.md');
    const block = readme.split('## Структура')[1].split('```')[1];
    const paths = [...block.matchAll(/^(\S+)/gm)].map((m) => m[1].replace(/\.\*$/, '.js'));
    assert.ok(paths.length > 10);
    for (const p of paths) {
      const target = p.endsWith('/') ? p : p;
      assert.ok(exists(target), `README упоминает ${p}, но его нет`);
    }
  });

  test('все исходники упомянуты в разделе «Структура» README', () => {
    const block = read('README.md').split('## Структура')[1].split('```')[1];
    for (const f of jsFiles) {
      const dir = f.includes('/') ? `${f.split('/')[0]}/` : f;
      const base = f.replace(/\.js$/, '');
      assert.ok(block.includes(f) || block.includes(`${base}.*`) || block.includes(dir), `README не описывает ${f}`);
    }
  });

  test('локальные ссылки и картинки в README ведут на существующие файлы', () => {
    const readme = read('README.md');
    const refs = [...readme.matchAll(/\]\(([^)\s]+)\)|\bsrc="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    const local = refs.filter((r) => !/^(https?:|mailto:|#)/.test(r));
    for (const r of local) assert.ok(exists(decodeURIComponent(r.split('#')[0])), `README ссылается на ${r}, но его нет`);
  });

  test('CHANGELOG.md начинается с шапки, которую ведёт changelog-prepend', () => {
    assert.ok(read('CHANGELOG.md').startsWith(HEADER));
  });

  test('каталоги из «Структуры» не пустые', () => {
    for (const d of ['lib', 'content', 'popup', 'pages', 'icons']) {
      assert.ok(statSync(path(d)).isDirectory() && readdirSync(path(d)).length, d);
    }
  });
});

describe('тесты и плашки', () => {
  const testFiles = ['unit', 'pages', 'integrity'].flatMap((d) =>
    readdirSync(path(`tests/${d}/`))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => `tests/${d}/${f}`),
  );

  test('каждый тестовый файл попадает в какую-то плашку README (scripts/badges.js)', () => {
    const covered = new Set(SUITES.flatMap((s) => s.files));
    for (const f of testFiles) assert.ok(covered.has(f), `${f} не входит ни в один набор SUITES`);
    for (const f of covered) assert.ok(exists(f), `в SUITES указан несуществующий ${f}`);
  });

  test('блок плашек в README совпадает с генератором — запустите npm run badges, если менялись наборы', () => {
    const readme = read('README.md');
    const block = readme.split('<!-- badges:start -->')[1]?.split('<!-- badges:end -->')[0];
    assert.ok(block, 'нет блока <!-- badges:start --> … <!-- badges:end -->');
    const repo = block.match(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/workflows\//)?.[1];
    assert.ok(repo, 'в блоке нет ссылки на workflow');
    assert.equal(block.trim(), badgesMarkdown(repo));
  });

  test('плашки тестов живые и ведут на страницу workflow tests.yml', () => {
    const lines = badgesMarkdown('o/r').split('\n');
    const workflow = '(https://github.com/o/r/actions/workflows/tests.yml?query=branch%3Amain)';
    const all = lines.find((l) => l.startsWith('[![All tests]'));
    assert.ok(all.includes('https://img.shields.io/github/actions/workflow/status/o/r/tests.yml?branch=main'));
    assert.ok(all.endsWith(workflow));
    for (const s of SUITES) {
      const line = lines.find((l) => l.startsWith(`[![${s.label}]`));
      assert.ok(line, s.label);
      assert.ok(line.includes(encodeURIComponent(`https://raw.githubusercontent.com/o/r/badges/${s.id}.json`)), `${s.label}: JSON из ветки badges`);
      assert.ok(line.endsWith(workflow), `${s.label}: ссылка на workflow`);
    }
    assert.equal(new Set(SUITES.map((s) => s.id)).size, SUITES.length, 'id наборов повторяются');
    assert.ok(lines.some((l) => l.includes('https://img.shields.io/github/v/release/o/r?sort=semver')));
  });

  test('JSON плашки: «passing» только при успешном прогоне, иначе «failing» со счётом', () => {
    const okRun = { code: 0, tests: 3, pass: 3, fail: 0, todo: 0 };
    assert.deepEqual(endpointBadge('Store tests', okRun), {
      schemaVersion: 1,
      label: 'Store tests',
      message: 'passing',
      color: '4c1',
      namedLogo: 'github',
      logoColor: 'white',
      cacheSeconds: 300,
    });
    const failed = endpointBadge('Popup tests', { code: 1, tests: 29, pass: 27, fail: 2, todo: 0 });
    assert.equal(failed.message, 'failing 27/29');
    assert.equal(failed.color, 'e05d44');
    assert.equal(endpointBadge('X', { ...okRun, code: 1 }).message, 'failing 3/3', 'процесс упал — не passing');
    assert.equal(endpointBadge('X', { ...okRun, tests: 0, pass: 0 }).message, 'failing 0/0', 'ни одного теста — не passing');
  });

  test('репозиторий определяется по GITHUB_REPOSITORY и адресу origin', () => {
    assert.equal(repoSlug('allakin/Uniform-design-checker'), 'allakin/Uniform-design-checker');
    assert.equal(repoSlug('https://github.com/allakin/Uniform-design-checker.git\n'), 'allakin/Uniform-design-checker');
    assert.equal(repoSlug('git@github.com:allakin/Uniform-design-checker.git'), 'allakin/Uniform-design-checker');
    assert.equal(repoSlug('https://github.com/o/r'), 'o/r');
    assert.equal(repoSlug('https://gitlab.com/o/r.git'), null);
  });

  test('генератор заменяет только блок плашек', () => {
    const out = replaceBlock('# T\n<!-- badges:start -->\nold\n<!-- badges:end -->\nтекст', 'new');
    assert.equal(out, '# T\n<!-- badges:start -->\nnew\n<!-- badges:end -->\nтекст');
    assert.throws(() => replaceBlock('без блока', 'x'), /badges:start/);
  });
});
