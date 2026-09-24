import THEMES from './themes.json';

export const THEME_LIST = [...THEMES.themes, THEMES.fallback].map(t => ({ id: t.id, label: t.label }));
export const THEME_IDS = new Set(THEME_LIST.map(t => t.id));

/** "https://en.wikipedia.org/wiki/Hip_hop_music" -> "Hip_hop_music" */
export const topicSlug = url => decodeURIComponent(String(url).replace(/^.*\/wiki\//, ''));

/** Same rule as ingest/classify_local.py: first theme by topic, then by category. */
export function themeFor(topics, categoryId) {
  const set = new Set(topics || []);
  for (const t of THEMES.themes) if (t.topics.some(x => set.has(x))) return t.id;
  for (const t of THEMES.themes) if (t.categories.includes(Number(categoryId))) return t.id;
  return THEMES.fallback.id;
}
