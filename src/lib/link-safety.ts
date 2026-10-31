/**
 * 富文本链接白名单。
 * `//host` 与 `/\host` 都会被浏览器解析成跳转外域的协议相对链接，必须显式排除。
 */
export type LinkKind = 'http' | 'mailto' | 'site' | null;

export function linkKind(href: unknown): LinkKind {
  if (typeof href !== 'string') return null;
  if (/^https?:/i.test(href)) return 'http';
  if (/^mailto:/i.test(href)) return 'mailto';
  if (/^\/(?!\/|\\)/.test(href)) return 'site';
  return null;
}
