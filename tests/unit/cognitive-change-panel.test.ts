import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 4.3「变化」区块的静态断言（片 h-5）。
 *
 * 和记忆网络、洞察两屏同一个理由：vitest 跑在 node 环境，这套测试体系里没有 jsdom，
 * JSX 和 onClick 根本没法运行。所以这一屏能验的三件事都用读源码的方式验：
 * 一、**句子只有一个出处**。这一屏的话全来自 `change-display.ts`，界面里再抄一份字面量，
 *    改了 display 的就是没显示的那一份。
 * 二、**一个动作一个入口**。纠正、永久删除只在事件列表和「记忆」那两屏有入口，
 *    开关只在时间线那一屏有控件——这一区块要是再来一个 checkbox，关掉哪个用户不知道听谁的。
 * 三、**它跟着闸门走**。区块挂在 `enabled === true` 分支里，开关关着时一个请求都不发。
 *
 * 界面本身（真实数据下好不好读、观察多了会不会挤爆这一屏）**不在这里验收**，
 * 文档里明说它是无法验收项——本机没有 jsdom，也没有起服务真渲染过这一区块。
 */
const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const REGION = read('src/components/settings/timeline-changes.tsx');
const REGION_CODE = stripComments(REGION);
const PANEL = read('src/components/settings/timeline-panel.tsx');
const PANEL_CODE = stripComments(PANEL);

describe('句子只有一个出处', () => {
  it('主题×信号、证据不足、是否确认过都走 display 的函数', () => {
    expect(REGION).toContain('describeChangeSignal(');
    expect(REGION).toContain('describeInsufficientChange(');
    expect(REGION).toContain('describeChangeConfirmation(');
  });

  /** 界面里出现这些字面量就意味着两份已经开始漂了。 */
  it('界面里不许另抄句式表的字面量', () => {
    for (const phrase of [
      '说法换过一版',
      '出现了完成说法',
      '这句话被撤回',
      '多了一版说法',
      '放了很久没再提',
      '一直在反复提到',
      '最近才反复提到',
      '从一件转到了另一件',
      '提到的次数还不够',
      '只出现在同一个对话里',
      '亲口说过或确认过',
      '由记录推断'
    ]) {
      expect(REGION_CODE).not.toContain(phrase);
    }
  });

  it('常驻说明与三个标题走常量，且只出现在这一份里', () => {
    for (const name of [
      'CHANGES_ARE_OBSERVATIONS_NOTE',
      'CHANGES_EMPTY_NOTE',
      'INTEREST_SOURCE_NOTE',
      'CHANGE_BEFORE_LABEL',
      'CHANGE_AFTER_LABEL'
    ]) {
      expect(REGION).toContain(name);
    }
    expect(REGION_CODE).not.toContain('之前：');
    expect(REGION_CODE).not.toContain('之后：');
  });

  /** 截断那句必须来自 describeChangesCap：静默的「这里没有」会被读成「更早没发生过」。 */
  it('读到上限时那一行来自 describeChangesCap，界面不自己算', () => {
    expect(REGION).toContain('describeChangesCap(');
    expect(REGION_CODE).not.toContain('记忆条数已达上限');
  });

  it('样本数与跨度复用洞察那屏的 describeEvidenceVolume，不另写一套数字说法', () => {
    expect(REGION).toContain('describeEvidenceVolume(');
    expect(REGION).toContain('describeReflectionTime(');
    expect(REGION_CODE).not.toMatch(/基于.*条记忆/);
  });
});

describe('一个动作一个入口', () => {
  /** 开关属于时间线那一屏，这一区块连 PATCH 都不该发。 */
  it('没有任何写请求，也没有第二个开关', () => {
    expect(REGION_CODE).not.toContain('PATCH');
    expect(REGION_CODE).not.toContain('checkbox');
    expect(REGION_CODE).not.toContain('onChange');
  });

  it('不摆纠正和永久删除：那两个动作的入口在事件列表和「记忆」屏', () => {
    expect(REGION_CODE).not.toContain('永久删除');
    expect(REGION_CODE).not.toContain('更正');
    expect(REGION_CODE).not.toContain('归档');
    expect(REGION_CODE).not.toContain('/api/account/cognitive/memories');
  });

  it('唯一的请求是那一条只读端点，且不带动词', () => {
    expect(REGION).toContain("const CHANGES_URL = '/api/account/cognitive/changes'");
    // 只数调用点：`apiFetch` 这个词在 import 那一行还会出现一次，把它算进来这条永远红。
    expect(REGION_CODE.match(/apiFetch[<(]/g)?.length).toBe(1);
  });

  /** 门槛是「隔了多少天」，客户端能传时间就能造出一条变化——`now` 只能由服务端盖。 */
  it('请求串里没有任何时间参数', () => {
    expect(REGION_CODE).not.toContain('now=');
    expect(REGION_CODE).not.toMatch(/apiFetch[^)]*\?/);
  });
});

describe('正文只从旁表按 id 取', () => {
  /**
   * 观察结构里没有记忆正文（那样才能进日志），界面要的两句走 `sources` 旁表。
   * 这一条钉的是「界面不自己去拼一条记忆请求」——那等于绕过旁表把正文拽进这个组件。
   */
  it('句子取自 data.sources，按 id 命中才渲染', () => {
    expect(REGION).toContain('data.sources[id]');
    expect(REGION_CODE).not.toContain('contentCiphertext');
  });

  it('记忆正文不进日志：这个文件里没有 console', () => {
    expect(REGION_CODE).not.toContain('console.');
  });
});

describe('跟着时间线的闸门走', () => {
  /**
   * 位置就是闸门：区块摆在 `enabled === true` 那一支里，开关关着时它跟着整支不渲染，
   * 一个请求都不发。判法用去注释后的源码，取该支起点到 `</section>` 之间那一段。
   */
  it('区块挂在 enabled === true 那一支里，开关关着时它连请求都不发', () => {
    expect(PANEL).toContain('import { TimelineChanges } from');
    expect(PANEL).toContain('<TimelineChanges revision={revision} />');
    const branchStart = PANEL_CODE.indexOf("enabled === true ? (");
    const sectionEnd = PANEL_CODE.indexOf('</section>');
    const changesAt = PANEL_CODE.indexOf('<TimelineChanges');
    expect(branchStart).toBeGreaterThan(-1);
    expect(changesAt).toBeGreaterThan(branchStart);
    expect(changesAt).toBeLessThan(sectionEnd);
  });

  /** 更正和永久删除之后观察会变（改口就是演化边），不跟着刷新就是让用户看着一份过期的变化。 */
  it('两个写动作成功后都把 revision 顶上去，区块跟着重读', () => {
    expect(PANEL).toContain('const [revision, setRevision] = useState(0)');
    expect(PANEL_CODE.match(/setRevision\(\(value\) => value \+ 1\)/g)?.length).toBe(2);
  });

  it('区块自己只认 revision 这一个依赖，不跟事件列表共用状态', () => {
    expect(REGION).toContain('}, [revision]);');
  });
});

describe('客户端包边界', () => {
  /**
   * `change-detector.ts` 运行时 import 了 prisma 的枚举，界面要它的形状只能靠
   * `import type`；非类型 import 里 cognitive 目录只许是那两份纯词汇表。
   */
  it('两个组件的非类型 import 里 cognitive 目录下只有 display 词汇表', () => {
    for (const [name, source] of [
      ['timeline-changes.tsx', REGION],
      ['timeline-panel.tsx', PANEL]
    ] as const) {
      const withoutTypeImports = source.replace(/import type [\s\S]*?from\s+'[^']+';/g, '');
      const cognitive = [
        ...new Set([...withoutTypeImports.matchAll(/\bfrom\s+'(@\/lib\/cognitive\/[^']+)'/g)].map((match) => match[1]))
      ].sort();
      const allowed =
        name === 'timeline-changes.tsx'
          ? ['@/lib/cognitive/change-display', '@/lib/cognitive/reflection-display']
          : ['@/lib/cognitive/memory-display'];
      expect(cognitive).toEqual(allowed);
      expect(withoutTypeImports).not.toContain('@prisma/client');
    }
  });

  it('检测层只以 import type 的形式出现在区块里', () => {
    expect(REGION).toMatch(/import type \{[^}]*ChangeObservation[^}]*\} from '@\/lib\/cognitive\/change-detector'/);
    expect(stripComments(REGION).replace(/import type [\s\S]*?;/g, '')).not.toContain('change-detector');
  });
});
