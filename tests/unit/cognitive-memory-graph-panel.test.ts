import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 记忆网络那一屏的静态断言（任务书 8.2，片 c）。
 *
 * 和洞察一屏同一个理由：vitest 跑在 node 环境，这套测试体系里没有 jsdom 和渲染器，
 * JSX 里的 `<svg>` 和 onClick 根本没法运行。所以这一屏能验的三件事都用读源码的方式验：
 * 一、**说好的句子不许被悄悄改掉**。「现在还不是一张图……不猜」那句是他过目的产物，
 *    而且它必须**来自 `describeNotAGraph`**——界面里再抄一份，两处就会漂成两个说法。
 * 二、**画不画得出来只有一个判据**。`isGraphDrawable` 是唯一那道判，界面不许自己写
 *    「有线就画」；否则「两个点一根线也画成图」这个已经被判过的样子会绕着纯函数回来。
 * 三、**这张图只读**。纠正、永久删除、归档都只在「记忆」和「认知时间线」两屏有入口
 *    （一个动作一个入口），这一屏要是再开一对按钮，同一个动作就有了第三个入口和第三套文案。
 *
 * 界面本身（SVG 在各浏览器里的实际排布、点够多时会不会重叠、真实数据下好不好读）
 * **不在这里验收**，报告里明说它是无法验收项——本机没有 jsdom，也没有起服务真渲染过这一屏。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const PANEL = read('src/components/settings/memory-graph-panel.tsx');
const PANEL_CODE = stripComments(PANEL);
const WORKSPACE = read('src/components/settings/settings-workspace.tsx');
const PACKAGE = read('package.json');

describe('这一屏说的话', () => {
  it('标题与说明：说清线是从哪三种已经存在的关系推来的', () => {
    expect(PANEL).toContain('记忆网络');
    expect(PANEL).toContain(
      '把已经存在的记忆连起来：谁被谁更新成、哪些是在同一场对话里说的、哪些被同一条洞察一起提到过。连线全部从库里的真实关系推导，不猜。'
    );
  });

  it('开关三态与未打开时那句', () => {
    expect(PANEL).toContain('开关状态未知');
    expect(PANEL).toContain('关闭时这一屏不读取你的记忆。打开后才会连出这张图。');
    expect(PANEL).toContain('记忆网络已打开');
    expect(PANEL).toContain('记忆网络已关闭');
  });

  /**
   * 钉的是「这句话只有一个来源」：界面里出现这个字面量，就意味着 display 那份改了、
   * 这里还是旧的——而用户看到的是这里的版本。
   */
  it('画不出来时那句必须来自 describeNotAGraph，界面里不许另抄一份', () => {
    expect(PANEL).toContain('describeNotAGraph(');
    expect(PANEL_CODE).not.toContain('现在还不是一张图');
    expect(PANEL_CODE).not.toContain('连不成一张图');
  });

  it('预算提示来自 describeGraphBudget，界面不许自己算截断了多少', () => {
    expect(PANEL).toContain('describeGraphBudget(');
    expect(PANEL_CODE).not.toMatch(/总[计数].{0,6}-\s*(nodes|edges)\.length/);
  });

  it('点的位置不表示任何东西，这句话要摆在界面上', () => {
    expect(PANEL).toContain('点的位置只为了铺开不重叠，不表示任何东西。');
  });

  it('图例的三种线名来自 GRAPH_EDGE_LABELS，不在界面里另起一套', () => {
    expect(PANEL).toContain('GRAPH_EDGE_LABELS');
    expect(PANEL_CODE).not.toContain('同一场对话里说过');
    expect(PANEL_CODE).not.toContain('同一条洞察里一起提到');
  });

  it('点的颜色按主题，主题名复用 memory-display 的 CONTEXT_LABELS', () => {
    expect(PANEL).toContain('GRAPH_CONTEXT_COLORS');
    expect(PANEL).toContain('CONTEXT_LABELS');
  });
});

describe('画不画得出来只有一个判据', () => {
  it('由 isGraphDrawable 判，界面不另写一份「有线就画」', () => {
    expect(PANEL).toContain('isGraphDrawable(');
    // 只挡 `… > 0 &&` 那种写法会被 `graph.edges.length > 0;` 绕过——变异探针实测过。
    // 这一屏比较边数的地方只许是 isGraphDrawable 那一次，所以源码里根本不该出现这个比较。
    expect(PANEL_CODE).not.toMatch(/edges\.length\s*>/);
  });

  it('画得出来时是手写 SVG，画不出来时是记忆列表兜底', () => {
    expect(PANEL).toContain('<svg');
    expect(PANEL).toContain('graph.nodes.map');
  });

  /**
   * 没有图形库这件事是硬约束，不是洁癖：任务书要的是「从已有关系推导」，
   * 而 d3-force / cytoscape 这类库会替用户算出一张**位置有意义**的图——
   * 那批坐标既不在库里也不可解释，正是这一片判掉的东西。顺带解决客户端包体积。
   */
  it('仓库里没有图布局依赖，这一屏的坐标是自己算的', () => {
    expect(PANEL_CODE).not.toMatch(/\bfrom\s+'(?:d3|cytoscape|vis-network|react-force-graph)[^']*'/);
    for (const name of ['d3', 'cytoscape', 'vis-network', 'react-force-graph', 'viz.js']) {
      expect(PACKAGE).not.toContain(`"${name}"`);
    }
    expect(PANEL).toContain('Math.cos');
    expect(PANEL).toContain('Math.sin');
  });
});

describe('这一屏只读', () => {
  /** 一个动作一个入口：写动作留在「记忆」与「认知时间线」两屏，这里连端点都不引。 */
  it('不出现任何记忆写端点，也不出现删除/更正/归档的按钮', () => {
    expect(PANEL_CODE).not.toContain('/api/account/cognitive/memories');
    expect(PANEL_CODE).not.toContain('永久删除');
    expect(PANEL_CODE).not.toContain('更正');
    expect(PANEL_CODE).not.toContain('归档');
  });

  it('唯一的 PATCH 是这一屏自己的开关，请求体里只有 associationEnabled', () => {
    expect(PANEL).toContain('associationEnabled: !enabled');
    expect(PANEL_CODE.match(/method: 'PATCH'/g)).toHaveLength(1);
  });

  it('开关没确认打开时一个图请求都不发（读的是记忆正文）', () => {
    expect(PANEL).toContain('if (enabled === true) void loadGraph();');
  });

  it('记忆正文不进日志：这个文件里没有 console', () => {
    expect(PANEL_CODE).not.toContain('console.');
  });
});

describe('客户端包边界', () => {
  /**
   * `memory-graph.ts` 运行时 import 了 policy.ts，policy.ts import 了 prisma。
   * 这一屏要它的节点形状只能靠 `import type`——编译期抹掉，不产生运行时依赖。
   * 判法：先把 `import type ... from '...';` 整段抹掉，剩下的 `from '...'` 里
   * 凡是 `@/lib/cognitive/` 开头的，只许是那两份**本身就是为浏览器包写的**词汇表
   * （`memory-display.ts` 和 `memory-graph-display.ts`，两者各自被自己的用例钉着「除类型外不 import」）。
   * 白名单只列这两个，多引一个服务端模块就红。
   */
  it('非类型 import 里 cognitive 目录下只有那两份 display 词汇表', () => {
    const withoutTypeImports = PANEL.replace(/import type [\s\S]*?from\s+'[^']+';/g, '');
    const cognitive = [...new Set([...withoutTypeImports.matchAll(/\bfrom\s+'(@\/lib\/cognitive\/[^']+)'/g)].map((match) => match[1]))].sort();
    expect(cognitive).toEqual(['@/lib/cognitive/memory-display', '@/lib/cognitive/memory-graph-display']);
    expect(withoutTypeImports).not.toContain('@prisma/client');
  });
});

describe('设置页接线', () => {
  it('tab 三处都到位：联合类型、导航项、渲染分支', () => {
    expect(WORKSPACE).toContain("| 'memoryGraph'");
    expect(WORKSPACE).toContain("['memoryGraph', '记忆网络', Network]");
    expect(WORKSPACE).toContain("{tab === 'memoryGraph' ? <MemoryGraphPanel /> : null}");
    expect(WORKSPACE).toContain("import { MemoryGraphPanel } from './memory-graph-panel'");
  });
});
