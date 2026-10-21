import { getReview, getActiveReview } from '../lib/store.js';
import { REPORT_CSS, buildReportBody, buildReportDocument, reportFileName, installLightbox, installToc, lightboxIcons } from '../lib/report.js';
import { icon } from '../lib/icons.js';
import * as folder from '../lib/folder.js';

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status');
document.getElementById('btn-html').innerHTML = `${icon('download', 14)} Скачать HTML`;
document.getElementById('btn-pdf').innerHTML = `${icon('download', 14)} Сохранить в PDF`;

function downloadHtml(review) {
  const blob = new Blob([buildReportDocument(review)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reportFileName(review, 'html');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  statusEl.textContent = 'HTML-файл скачан';
}

// Если выбрана папка для результатов и доступ есть — пишем отчёт туда, иначе скачиваем файл.
async function exportHtml(review) {
  try {
    const dir = await folder.getDir();
    if (dir && (await folder.permission(dir)) === 'granted') {
      const sub = await folder.writeReview(dir, review);
      await folder.setStatus({ state: 'ok', dirName: dir.name, lastSyncAt: Date.now(), error: '' });
      statusEl.textContent = `Сохранено: ${dir.name}/${sub}/Отчёт.html`;
      return;
    }
  } catch (e) {
    statusEl.textContent = `Не удалось записать в папку (${e.message}) — скачиваю файл`;
  }
  downloadHtml(review);
}

async function printPdf() {
  // Ждём загрузки скриншотов, иначе в PDF попадут пустые места.
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  statusEl.textContent = 'В окне печати выберите «Сохранить как PDF»';
  window.print();
}

async function main() {
  const review = params.get('id') ? await getReview(params.get('id')) : await getActiveReview();
  if (!review) {
    document.getElementById('report').innerHTML = '<p style="padding:40px;text-align:center">Ревью не найдено.</p>';
    document.querySelectorAll('.tb-btn').forEach((b) => (b.disabled = true));
    return;
  }
  document.title = reportFileName(review, 'pdf').replace(/\.pdf$/, ''); // имя PDF по умолчанию берётся из title
  document.getElementById('report-style').textContent = REPORT_CSS;
  document.getElementById('report').innerHTML = buildReportBody(review);
  installLightbox(document, lightboxIcons());
  installToc(document);

  document.getElementById('btn-html').addEventListener('click', () => downloadHtml(review));
  document.getElementById('btn-pdf').addEventListener('click', printPdf);

  const action = params.get('action');
  if (action === 'html') exportHtml(review);
  else if (action === 'pdf') setTimeout(printPdf, 300);
}

main();
// Дописываем изменения, сделанные без открытой страницы; без доступа — просим его при первом клике.
folder.flushUnsaved().then(async () => {
  const dir = await folder.getDir();
  if (dir && (await folder.permission(dir).catch(() => 'prompt')) === 'prompt') folder.regainAccessOnClick(document, dir);
});
