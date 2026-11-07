/**
 * 弹层滚动锁（Modal / 抽屉共用）。
 *
 * 为什么不用「打开时捕获 body.style.overflow、关闭时写回」的常见写法：
 * 页面上可以同时存在多个弹层（比如「添加全局模型」表单 + 它提交时弹出的密码确认框），
 * 后打开的那个会把前一个已经写上的 'hidden' 当成原值捕获下来；一旦关闭顺序不是严格的
 * 后进先出（表单提交成功后先关掉自己，确认框后关），最后写回的就是 'hidden'，
 * body 上永久漏一个 overflow:hidden —— 表现就是后台「系统配置」再也滚不动了。
 *
 * 这里改成引用计数：只有第一个打开的弹层捕获并保存真正的原值，只有最后一个关闭的弹层
 * 写回它。中间任何交错都不会污染 body。
 */

let savedOverflow: string | null = null;
let openCount = 0;

export function lockScroll(): void {
  openCount += 1;
  if (openCount === 1) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

export function unlockScroll(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0 && savedOverflow !== null) {
    document.body.style.overflow = savedOverflow;
    savedOverflow = null;
  }
}

/* 以下为测试可见性用的只读/重置口，产品代码不要调用。 */

export function scrollLockOpenCount(): number {
  return openCount;
}

export function resetScrollLock(): void {
  openCount = 0;
  savedOverflow = null;
}
