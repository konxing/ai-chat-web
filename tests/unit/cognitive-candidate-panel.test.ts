import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 待确认候选那一块的静态断言（片M-6）。
 *
 * 和洞察、画像那两屏同一套办法：vitest 跑在 node 环境，没有 jsdom，JSX 点不起来。
 * 所以这里验两件真能验的事——批准的文案不被悄悄改掉，以及不许出现没有消费者的交互。
 *
 * 这一块最容易被改错的地方是它的**闸门形状和别的认知屏相反**：
 * 读列表和点「不要记」都不许问 `memoryEnabled`（片M-4 的裁决，理由写在 `candidates/route.ts` 头上——
 * 关掉长期记忆之后门口那批原话看不见也答不了，等于系统替用户留着他的原话却不给碰），
 * 只有「记住」会在服务端撞 409。所以界面不许出现 `memoryEnabled` 这个词：出现了就意味着有人
 * 把这块当成了普通模块视图，顺手补了一道「漏掉的闸门」。
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

const PANEL = read('src/components/settings/memory-candidates-panel.tsx');
const PANEL_CODE = stripComments(PANEL);
const MEMORY_PANEL = stripComments(read('src/components/settings/memory-panel.tsx'));

describe('待确认候选一屏：批准的文案逐字钉住', () => {
  it('标题和说明说清「你没答过它就不进长期记忆」，不许写成已经记住了', () => {
    expect(PANEL).toContain('等你回答的话');
    expect(PANEL).toContain('这些句子系统想记，但按你的策略得先问你。你没答过的，一条都不会进长期记忆。');
  });

  it('两个动作就叫「记住」和「不要记」，不给第三个「先放着」的档位', () => {
    expect(PANEL).toContain('记住');
    expect(PANEL).toContain('不要记');
    expect(PANEL).not.toContain('稍后');
    expect(PANEL).not.toContain('待定');
  });

  it('两档过滤：还没答的、以及「这句为什么不再问了」的答案（那一条已拒绝行）', () => {
    expect(PANEL).toContain('还没答的');
    expect(PANEL).toContain('不再问的');
  });

  it('「不再问的」那一档空着时那句话不许说成「没有东西被排除」：排除表是另一张表', () => {
    expect(PANEL).toContain('还没有答过「不要记」的句子。');
  });

  it('答完之后列表跟着变空，空态那句不许承诺「马上就有」', () => {
    expect(PANEL).toContain('没有等你回答的话');
  });
});

describe('待确认候选一屏：接口接线', () => {
  it('两份列表各读一次，状态过滤走查询串而不是新端点', () => {
    expect(PANEL_CODE).toContain(
      "apiFetch<{ candidates: MemoryCandidateDto[]; capped: boolean }>('/api/account/cognitive/candidates')"
    );
    expect(PANEL_CODE).toContain("'/api/account/cognitive/candidates?status=rejected'");
  });

  it('回答走 PATCH，动词只有这两个', () => {
    expect(PANEL_CODE).toContain("method: 'PATCH', json: { action: 'confirm' }");
    expect(PANEL_CODE).toContain("method: 'PATCH', json: { action: 'reject' }");
    expect(PANEL_CODE).toContain('encodeURIComponent(entry.id)');
  });

  it('确认会在服务端撞闸门：界面上报的是接口那句人话，不是自己编的', () => {
    expect(PANEL_CODE).toContain('errorMessage(err)');
    expect(PANEL_CODE).toContain('push(');
  });

  it('记住之后要通知父级重读记忆列表——那一行刚成为记忆，不刷新就是屏上少一条', () => {
    expect(PANEL_CODE).toContain('onConfirmed');
    expect(MEMORY_PANEL).toContain('<MemoryCandidatesPanel onConfirmed={() => void load()} />');
  });

  it('截断提示走纯函数，界面不许自己写死 200', () => {
    expect(PANEL_CODE).toContain('describeCandidateListCap');
    expect(PANEL_CODE).not.toMatch(/200/);
  });
});

describe('待确认候选一屏：闸门形状反过来（片M-4 的裁决）', () => {
  it('整块代码里不许出现 memoryEnabled：读和拒都不问它，确认由服务端 409 兜', () => {
    expect(PANEL_CODE).not.toContain('memoryEnabled');
    expect(PANEL_CODE).not.toContain('memoryWritePaused');
    expect(PANEL_CODE).not.toContain('/api/account/cognitive?');
  });

  it('两份列表都没内容时整块不渲染：一段空的「等你回答」标题只会让人以为系统在瞒话', () => {
    expect(PANEL_CODE).toContain('return null');
  });

  it('一次只许一个动作在飞：忙碌中的行禁用按钮，别的行也一样（同一条双击会撞 409）', () => {
    expect(PANEL_CODE).toContain("disabled={busy !== ''");
  });

  it('正文只摆在界面上，不许进 console 或任何日志出口', () => {
    expect(PANEL_CODE).not.toContain('console.');
    expect(PANEL_CODE).not.toContain('log.');
  });
});
