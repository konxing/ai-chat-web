export const DEEPSEEK_WEB_MODES = ['search', 'read'] as const;
export type DeepSeekWebMode = (typeof DEEPSEEK_WEB_MODES)[number];

export function supportsDeepSeekWeb(provider: { baseUrl: string; modelId: string }): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === 'https://api.deepseek.com' &&
      !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/v1', '/v1/'].includes(url.pathname) &&
      provider.modelId === 'deepseek-flash';
  } catch {
    return false;
  }
}

/** Keep only public-format, clickable citations. The app never fetches these URLs. */
export function deepSeekCitationUrls(annotations: unknown): string[] {
  const urls = new Set<string>();
  if (!Array.isArray(annotations)) return [];
  for (const entry of annotations) {
    const raw = entry?.type === 'url_citation' ? entry.url_citation?.url : null;
    if (typeof raw !== 'string' || raw.length > 2048) continue;
    try {
      const url = new URL(raw);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        urls.add(url.href.replace(/[<>\s]/g, encodeURIComponent));
      }
    } catch {
      continue;
    }
    if (urls.size >= 8) break;
  }
  return [...urls];
}
