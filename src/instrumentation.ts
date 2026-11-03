import { log } from './lib/logger';

/**
 * Next 的启动钩子（任务书 §6 的 worker 入口）。
 *
 * 只在这里挂后台 worker：它必须跟着**服务进程**活，不能跟着某一次请求生灭。
 * 写在 server.js 里也行，但那会把认知引擎的东西散进通用服务器代码，而且 dev 下
 * Next 自己起的进程那条路径就漏了。
 *
 * 异常必须在这里咽掉。这一点在 Next 15 + 自定义 server 的组合下不是「难看」而是「致命」：
 * dev 和 prod 都会在端口打开之前 await 这个函数，本仓 server.js:282 直接 `await app.prepare()`，
 * 所以钩子抛错会沿 main() 的 catch 走到 process.exit(1)——整个网站起不来，起因是一个记账的后台任务。
 */
export async function register(): Promise<void> {
  // 写成肯定式的 if，不是 `!== 'nodejs'` 早退：Next 把 process.env.NEXT_RUNTIME 用
  // DefinePlugin 原地替换成字面量（edge 编译时是 'edge'），只有整个分支被 webpack 判定为常量 false
  // 才会把那条动态 import 从依赖图里摘掉。早退写法摘不掉，实测结果是 worker 被编进 edge bundle，
  // 连带 chats.ts 的 node:fs / node:dns 一起把 build 打死（UnhandledSchemeError）。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startCognitiveWorker } = await import('./lib/cognitive/task-worker');
      // 同步返回，不等任何一次库操作：冷启动时间不该挂在认知引擎上。
      startCognitiveWorker();
    } catch {
      // 只记事件名，不记 err.message——它会带上模块路径和配置值。
      log.warn('cognitive.worker_start_failed', { reason: 'instrumentation' });
    }
  }
}
