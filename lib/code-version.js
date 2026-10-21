// Отпечаток кода расширения: хеш файлов, от которых зависит запись ревью на диск.
// Нужен, чтобы заметить фоновый скрипт, работающий на старом коде. У распакованного расширения страницы
// подхватывают изменённые файлы при обновлении вкладки, а service worker выполняет код, загруженный при
// старте, пока расширение не перезагрузят, — и автосохранение пишет в папку данные в старом формате.
const FILES = [
  'background.js',
  'lib/store.js',
  'lib/folder.js',
  'lib/report.js',
  'lib/markdown.js',
  'lib/groups.js',
  'lib/url.js',
  'lib/icons.js',
  'lib/code-version.js',
];

// Строка из 16 hex-символов или null, если файлы прочитать не удалось.
export async function codeFingerprint() {
  try {
    const texts = await Promise.all(
      FILES.map(async (file) => {
        const res = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        return res.text();
      }),
    );
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\u0000')));
    return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export const REOPEN_KEY = 'reopenAfterReload'; // адрес страницы, которую открыть после перезагрузки расширения
