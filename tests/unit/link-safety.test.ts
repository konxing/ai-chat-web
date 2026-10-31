import { describe, expect, it } from 'vitest';
import { linkKind } from '@/lib/link-safety';

describe('链接白名单', () => {
  it('放行 http(s) 与 mailto 与站内绝对路径', () => {
    expect(linkKind('https://example.com/a')).toBe('http');
    expect(linkKind('HTTP://example.com')).toBe('http');
    expect(linkKind('mailto:me@example.com')).toBe('mailto');
    expect(linkKind('/api/files/abc')).toBe('site');
    expect(linkKind('/chat')).toBe('site');
  });

  it('拦下协议相对链接，避免跳到外域', () => {
    expect(linkKind('//evil.com')).toBeNull();
    expect(linkKind('/\\evil.com')).toBeNull();
    expect(linkKind('https:/\\evil.com')).not.toBe('site');
  });

  it('拦下脚本类伪协议与非字符串', () => {
    expect(linkKind('javascript:alert(1)')).toBeNull();
    expect(linkKind('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(linkKind('vbscript:msgbox(1)')).toBeNull();
    expect(linkKind(undefined)).toBeNull();
    expect(linkKind(null)).toBeNull();
    expect(linkKind(42)).toBeNull();
  });
});
