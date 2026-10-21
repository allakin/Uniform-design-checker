// Группы блоков: блоки с одинаковой логикой, снятые на разных страницах.
//   review.groups  — [{ id, title, description, mockupUrl, createdAt }] — порядок групп в отчёте
//   review.issues  — варианты: скриншот блока, страница, где он снят, и заметка; issue.groupId — его группа
// Варианты, чья группа не найдена (повреждённые данные), показываются отдельной группой «Без группы».

export const UNGROUPED_TITLE = 'Без группы';

// [{ group, variants: [issue] }] в порядке групп; пустые группы тоже показываются.
export function groupsOf(review) {
  const groups = Array.isArray(review?.groups) ? review.groups : [];
  const byId = new Map(groups.map((g) => [g.id, { group: g, variants: [] }]));
  const orphans = [];
  for (const issue of review?.issues || []) (byId.get(issue.groupId)?.variants || orphans).push(issue);
  const result = [...byId.values()];
  if (orphans.length) result.push({ group: { id: '', title: UNGROUPED_TITLE, description: '', mockupUrl: '' }, variants: orphans });
  return result;
}

export function groupTitleOf(review, issue) {
  return review?.groups?.find((g) => g.id === issue.groupId)?.title || UNGROUPED_TITLE;
}

// Адрес страницы без протокола, параметров и якоря: по нему считаются «разные страницы».
export function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(url || '');
  }
}

export function pagesCount(variants) {
  return new Set(variants.map((v) => pageKey(v.page?.url)).filter(Boolean)).size;
}

// Ревью из Design Review Checker: у замечаний свои названия, описания, критичность и картинки «Визуальные пояснения».
// Замечания с одинаковым названием становятся вариантами одной группы; описание и макет переходят в группу.
export function migrateLegacy(review, uid) {
  if (Array.isArray(review.groups) && review.issues.every((i) => review.groups.some((g) => g.id === i.groupId))) return review;
  const groups = Array.isArray(review.groups) ? [...review.groups] : [];
  const byTitle = new Map(groups.map((g) => [g.title, g]));
  const issues = review.issues.map((raw) => {
    if (groups.some((g) => g.id === raw.groupId)) return raw;
    const { title, description, mockupUrl, severity, fixImages, ...issue } = raw;
    const name = String(title || '').trim() || UNGROUPED_TITLE;
    let group = byTitle.get(name);
    if (!group) {
      group = { id: uid(), title: name, description: '', mockupUrl: '', createdAt: raw.createdAt || review.createdAt };
      groups.push(group);
      byTitle.set(name, group);
    }
    if (!group.description && String(description || '').trim()) group.description = description.trim();
    if (!group.mockupUrl && mockupUrl) group.mockupUrl = mockupUrl;
    return { ...issue, groupId: group.id, note: issue.note || '' };
  });
  return { ...review, groups, issues };
}
