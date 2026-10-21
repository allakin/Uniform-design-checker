// Проверка ссылок, которые вводит пользователь. Копия normalizeUrl есть в content/content.js.

// Пустая строка допустима; «figma.com/…» без протокола дополняется https://.
export function normalizeUrl(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: true, url: '' };
  for (const candidate of [v, `https://${v}`]) {
    try {
      const u = new URL(candidate);
      if (/^https?:$/.test(u.protocol) && u.hostname.includes('.')) return { ok: true, url: u.href };
    } catch {}
  }
  return { ok: false };
}

// Только http(s) — для вставки в href.
export function safeHref(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}
