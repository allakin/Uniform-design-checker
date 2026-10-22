// Прогоняет наборы тестов и пишет блок плашек в README.md между <!-- badges:start --> и <!-- badges:end -->.
// Плашки живые: README хранит только адреса, а состояние shields.io берёт при каждом показе.
//  - All tests — статус последнего прогона .github/workflows/tests.yml в основной ветке;
//  - release — последний опубликованный релиз на GitHub (semver, без черновиков и пре-релизов);
//  - наборы — JSON из ветки badges, который после каждого push в основную ветку публикует CI (npm run badges -- --out <папка>).
// Все плашки тестов ведут на страницу workflow tests.yml.
// Запуск: npm run badges [-- --out <папка для JSON>]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = `${ROOT}README.md`;

const WORKFLOW = 'tests.yml';
const BADGES_BRANCH = 'badges';
export const DEFAULT_BRANCH = 'main';

// id — имя JSON-файла плашки в ветке badges.
export const SUITES = [
  { id: 'store', label: 'Store tests', files: ['tests/unit/store.test.js'] },
  { id: 'report', label: 'Report tests', files: ['tests/unit/report.test.js'] },
  { id: 'folder', label: 'Folder tests', files: ['tests/unit/folder.test.js'] },
  { id: 'background', label: 'Background tests', files: ['tests/unit/background.test.js'] },
  { id: 'content', label: 'Content script tests', files: ['tests/unit/content.test.js'] },
  { id: 'utils', label: 'Utils tests', files: ['tests/unit/groups.test.js', 'tests/unit/url.test.js', 'tests/unit/markdown.test.js'] },
  { id: 'popup', label: 'Popup tests', files: ['tests/pages/popup.test.js'] },
  { id: 'pages', label: 'Pages tests', files: ['tests/pages/review.test.js', 'tests/pages/report-setup.test.js'] },
  { id: 'release', label: 'Release tests', files: ['tests/unit/changelog.test.js'] },
  { id: 'integrity', label: 'Integrity tests', files: ['tests/integrity/project.test.js'] },
];

function run(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const num = (name) => Number(out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
      resolve({ code, tests: num('tests'), pass: num('pass'), fail: num('fail'), todo: num('todo') });
    });
  });
}

// «owner/repo» из GITHUB_REPOSITORY (CI) или из адреса origin: https://github.com/o/r.git, git@github.com:o/r.git.
export function repoSlug(remote = process.env.GITHUB_REPOSITORY) {
  if (!remote) {
    try {
      remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return null;
    }
  }
  return remote.trim().match(/^(?:.*github\.com[:/])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

// «v1.2.3» / «1.2.3-rc.1» → { version, parts: [1, 2, 3], pre }; не semver → null.
export function parseVersion(tag) {
  const m = String(tag).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return m && { version: m[0].replace(/^v/, ''), parts: m.slice(1, 4).map(Number), pre: m[4] ?? '' };
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1; // 1.0.0 старше 1.0.0-rc.1
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true });
}

export async function fetchReleases(repo, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

const passed = (r) => r.code === 0 && r.fail === 0 && r.tests > 0;

// Ответ для https://img.shields.io/endpoint: https://shields.io/badges/endpoint-badge
export function endpointBadge(label, r) {
  const ok = passed(r);
  return {
    schemaVersion: 1,
    label,
    message: ok ? 'passing' : `failing ${r.pass}/${r.tests - r.todo}`,
    color: ok ? '4c1' : 'e05d44',
    namedLogo: 'github',
    logoColor: 'white',
    cacheSeconds: 300,
  };
}

export function badgesMarkdown(repo, branch = DEFAULT_BRANCH) {
  const workflow = `https://github.com/${repo}/actions/workflows/${WORKFLOW}?query=${encodeURIComponent(`branch:${branch}`)}`;
  const endpoint = (id) => `https://img.shields.io/endpoint?url=${encodeURIComponent(`https://raw.githubusercontent.com/${repo}/${BADGES_BRANCH}/${id}.json`)}`;
  return [
    '[![Browser extension](https://img.shields.io/badge/Browser-extension-e05d44?logo=googlechrome&logoColor=white)](#установка)',
    '![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285f4?logo=googlechrome&logoColor=white)',
    `[![Release](https://img.shields.io/github/v/release/${repo}?sort=semver&label=release&color=2ea44f&logo=github&logoColor=white)](https://github.com/${repo}/releases/latest)`,
    `[![All tests](https://img.shields.io/github/actions/workflow/status/${repo}/${WORKFLOW}?branch=${branch}&label=All%20tests&logo=github&logoColor=white)](${workflow})`,
    ...SUITES.map((s) => `[![${s.label}](${endpoint(s.id)})](${workflow})`),
  ].join('\n');
}

export function replaceBlock(readme, block) {
  const start = '<!-- badges:start -->';
  const end = '<!-- badges:end -->';
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a < 0 || b < a) throw new Error('В README.md нет блока <!-- badges:start --> … <!-- badges:end -->');
  return `${readme.slice(0, a + start.length)}\n${block}\n${readme.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.indexOf('--out');
  const outDir = outArg > 0 ? process.argv[outArg + 1] : null;
  const repo = repoSlug();
  if (!repo) throw new Error('Не удалось определить репозиторий GitHub: задайте GITHUB_REPOSITORY или origin на github.com');

  const results = await Promise.all(SUITES.map((s) => run(s.files)));
  SUITES.forEach((s, i) => {
    const r = results[i];
    console.log(`${passed(r) ? '✔' : '✖'} ${s.label.padEnd(22)} ${r.pass}/${r.tests - r.todo}${r.todo ? ` (todo: ${r.todo})` : ''}`);
  });

  // Сначала JSON: плашки должны показать результат прогона, даже если README сломан (это поймает тест целостности).
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    SUITES.forEach((s, i) => writeFileSync(join(outDir, `${s.id}.json`), `${JSON.stringify(endpointBadge(s.label, results[i]), null, 2)}\n`));
    console.log(`JSON плашек записан в ${outDir}.`);
  }
  try {
    writeFileSync(README, replaceBlock(readFileSync(README, 'utf8'), badgesMarkdown(repo)));
    console.log(`Блок плашек в README.md сверен (${repo}).`);
  } catch (e) {
    console.error(`✖ README.md: ${e.message}`);
    process.exitCode = 1;
  }
  if (!results.every(passed)) process.exitCode = 1;
}
