import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockScroll, resetScrollLock, scrollLockOpenCount, unlockScroll } from '@/lib/scroll-lock';

/**
 * 后台「添加全局模型 → 系统配置页再也滚不动」的回归测试。
 *
 * 旧实现是每个 Modal 各自「捕获 body.style.overflow → 关闭时写回」。
 * 交叠弹层（模型表单 + 密码确认框）会把前一个弹层写上的 'hidden' 当成原值捕获，
 * 一旦中间发生重渲染或非后进先出的关闭顺序，最后写回的就是 'hidden'，body 永久锁死。
 */

const body = { style: { overflow: '' } };

beforeEach(() => {
  resetScrollLock();
  body.style.overflow = '';
  (globalThis as { document?: unknown }).document = { body };
});

afterEach(() => {
  resetScrollLock();
  delete (globalThis as { document?: unknown }).document;
});

describe('scroll lock 引用计数', () => {
  it('第一个弹层保存真正的原值，最后一个弹层才写回', () => {
    lockScroll();
    expect(body.style.overflow).toBe('hidden');
    lockScroll();
    lockScroll();
    expect(scrollLockOpenCount()).toBe(3);
    unlockScroll();
    unlockScroll();
    expect(body.style.overflow).toBe('hidden');
    unlockScroll();
    expect(body.style.overflow).toBe('');
    expect(scrollLockOpenCount()).toBe(0);
  });

  it('交叠弹层里后打开的那个不会把 hidden 当成原值捕获', () => {
    lockScroll(); // 模型表单
    lockScroll(); // 密码确认框：旧实现在这里会捕获到 'hidden'
    unlockScroll(); // 表单先关闭
    unlockScroll(); // 确认框后关闭
    expect(body.style.overflow).toBe('');
  });

  it('多余的解锁不会把计数变负或污染 body', () => {
    unlockScroll();
    unlockScroll();
    expect(scrollLockOpenCount()).toBe(0);
    lockScroll();
    expect(body.style.overflow).toBe('hidden');
    unlockScroll();
    expect(body.style.overflow).toBe('');
  });

  it('Modal 用计数锁，不再各自捕获写回', () => {
    const source = readFileSync(new URL('../../src/components/ui.tsx', import.meta.url), 'utf8');
    expect(source).toContain('lockScroll()');
    expect(source).toContain('unlockScroll()');
    expect(source).not.toMatch(/document\.body\.style\.overflow\s*=/);
  });
});
