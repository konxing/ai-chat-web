import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「没记上的句子」那一块的静态断言（任务书 §6 要求④，片R-3）。
 *
 * vitest 跑在 node 环境，没有 jsdom，JSX 点不起来，所以这里验的两件都是真能验的：
 * 批准的文案不许被悄悄改掉；不许出现没有消费者的交互。
 *
 * 这一块最容易被改错的两处：
 * 一、它**不问任何模块开关**（裁决同 片L-1 和 `failed-tasks/route.ts` 头上那段）。
 *    源码里出现 `memoryEnabled` 就说明有人把这屏当成普通模块视图，顺手补了一道「漏掉的闸门」，
 *    而失败恰恰发生在模块开着的时候——补上那道门等于把要求④交给运维。
 * 二、句子必须把「不知道」留在原地。超时那一档服务端并不确定写没写进去，
 *    所以这一块不许出现「这句一定没记上」，也不许出现「已经帮你重跑」。
 *
 * 界面本身（像素、点击、真实数据下的排布）**不在这里验收**，报告里明说它是无法验收项。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/** 「不许出现某句话」要在去注释的源码上跑：文件头正是解释禁令的地方，全文自查会自己绊自己。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/failed-tasks-panel.tsx');
const PANEL_CODE = stripComments(PANEL);
const MEMORY_PANEL = stripComments(read('src/components/settings/memory-panel.tsx'));

describe('没记上的句子一块：批准的文案逐字钉住', () => {
  it('标题说「没记上」，说明说清原话还在对话里、这里只带到对话门口', () => {
    expect(PANEL_CODE).toContain('没记上的句子');
    expect(PANEL_CODE).toContain(
      '后台想把你对话里的话记进长期记忆，有几句试到最后没能完成。原话还在那次对话里，这里只带你到那次对话门口。'
    );
  });

  it('唯一的动作是「去看那次对话」：这里没有重跑、没有删除、也没有「知道了」', () => {
    expect(PANEL_CODE).toContain('去看那次对话');
    expect(PANEL_CODE).not.toContain('重试');
    expect(PANEL_CODE).not.toContain('知道了');
    expect(PANEL_CODE).not.toContain('忽略');
  });

  it('读不出来那句话单独一句，且不承诺任何后续动作', () => {
    expect(PANEL_CODE).toContain('没记上的句子读不出来：');
  });

  it('不谎称一定没记上，也不谎称系统会补记', () => {
    expect(PANEL_CODE).not.toContain('一定没有');
    expect(PANEL_CODE).not.toContain('我们会再试');
    expect(PANEL_CODE).not.toContain('已自动重试');
  });
});

describe('没记上的句子一块：接口接线', () => {
  it('只读那一个端点，不带查询参数：这一屏只有「我名下」一种范围', () => {
    expect(PANEL_CODE).toContain(
      "apiFetch<{ tasks: FailedTaskDto[]; capped: boolean }>('/api/account/cognitive/failed-tasks')"
    );
    expect(PANEL_CODE).not.toContain('/api/account/cognitive/failed-tasks?');
    expect(PANEL_CODE).not.toContain('method:');
  });

  it('三个数都来自服务端与纯函数：次数、原因、时间都不许在界面里现编', () => {
    expect(PANEL_CODE).toContain('FAILED_TASK_REASON_LABELS[task.reason]');
    expect(PANEL_CODE).toContain('describeFailedTaskAttempt(task.attempts)');
    expect(PANEL_CODE).toContain('timeAgo(task.failedAt)');
  });

  it('落点是会话页，chatId 走 encodeURIComponent：和记忆屏「来自哪次对话」同一写法', () => {
    expect(PANEL_CODE).toContain('href={`/chat/${encodeURIComponent(task.chatId)}`}');
  });

  it('截断提示走纯函数，界面不许自己写死 50', () => {
    expect(PANEL_CODE).toContain('describeFailedTaskListCap(capped, tasks.length)');
    expect(PANEL_CODE).not.toMatch(/\b50\b/);
  });
});

describe('没记上的句子一块：闸门形状反过来（片L-1 的裁决延伸）', () => {
  it('整块代码里不许出现任何开关的名字：这一屏读的全是调度列，一行记忆都不解密', () => {
    for (const flag of [
      'memoryEnabled',
      'memoryWritePaused',
      'reflectionEnabled',
      'timelineEnabled',
      'emotionEnabled',
      'adaptiveMemoryEnabled'
    ]) {
      expect(PANEL_CODE).not.toContain(flag);
    }
    expect(PANEL_CODE).not.toContain('/api/account/cognitive?');
  });

  it('一条判死都没有时整块不渲染：空标题只会让人以为系统在瞒话', () => {
    expect(PANEL_CODE).toContain('return null');
  });

  it('正文不出现在这一屏：DTO 里就没有正文字段，界面上也不许出现 content', () => {
    expect(PANEL_CODE).not.toContain('task.content');
    expect(PANEL_CODE).not.toContain('console.');
    expect(PANEL_CODE).not.toContain('log.');
  });
});

describe('客户端包边界', () => {
  /**
   * `failed-tasks.ts` 运行时 import 了 prisma，这一屏要它的 DTO 形状只能靠 `import type`。
   * 判法同记忆网络那一屏：抹掉类型导入后，剩下的 `@/lib/cognitive/` 引用只许是那份
   * 为浏览器包写的词汇表 `memory-display`。多引一个服务端模块就红。
   */
  it('非类型 import 里 cognitive 目录下只有 memory-display 一份', () => {
    const withoutTypeImports = PANEL.replace(/import type [\s\S]*?from\s+'[^']+';/g, '');
    const cognitive = [
      ...new Set(
        [...withoutTypeImports.matchAll(/\bfrom\s+'(@\/lib\/cognitive\/[^']+)'/g)].map((match) => match[1])
      )
    ].sort();
    expect(cognitive).toEqual(['@/lib/cognitive/memory-display']);
    expect(withoutTypeImports).not.toContain('@prisma/client');
  });
});

describe('记忆屏接线', () => {
  it('块挂在待确认那块下面、记忆列表上面，不跟着总开关消失', () => {
    expect(MEMORY_PANEL).toContain('<FailedTasksPanel />');
    expect(MEMORY_PANEL).toContain("import { FailedTasksPanel } from './failed-tasks-panel'");
  });
});
