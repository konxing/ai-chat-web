import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 任务书 8.2 的「个人认知中心」：一屏把七个模块聚在一起，每条一个**库里数出来的**真数。
 *
 * 这一屏自己没有任何数据——它是七张已有屏的门厅。所以它的全部风险只有两个，用例就只钉这两个：
 *
 * 一、**关着的屏不许给数字，也不许去数**。8.3 写的是「关闭模块后，不能继续执行对应的数据读取」，
 *     门厅为了凑一个「0」把用户的记忆行数一遍，就是把这句话反过来执行。
 *     这条不是断言文案能守住的，所以直接断**每张表被 count 了几次**。
 * 二、**数字不许撒谎**。三处细节全是为此：
 *     · 记忆管理和策略那两屏按片L 的裁决故意不吃开关（关着也得看得见、删得掉），所以它们的数照给；
 *     · `enabled` 逐字对齐各屏路由自己的 409 条件（记忆网络和时间线是两道闸，另三屏各一道），
 *       门厅说「打开」而点进去 409，和门厅说「没打开」而点进去有内容，是同一句假话的两个方向；
 *     · 各屏有列表行数上限（洞察/决策 100，记忆/画像 200），数到 101 却说「101 条」，
 *       点进去只能看到 100 条——那句「这一屏只列出最近 N 条」必须跟着数一起出来。
 *
 * 顺带钉住顺序：七个入口按任务书 8.2 列的那一二三四五六七排，不在这里重新发明信息架构。
 * 屏上的中文标签归界面（它才知道自己链到哪个 tab），服务端只给 key、开关状态和那一句话。
 */

const OVERVIEW_OFF = '这道闸没打开；打开后这里才会读取你的记忆内容';

type OverviewSection = { key: string; enabled: boolean; detail: string };
type Overview = { sections: OverviewSection[]; preferencesUnavailable: boolean };

const db = vi.hoisted(() => ({
  authThrows: false,
  preferencesThrows: false,
  preferences: {} as Record<string, boolean>,
  /** 每张表被 count 了几次——这一屏最要紧的证据不是返回值，是「没问」。 */
  counts: {} as Record<string, number>
}));

vi.mock('@/lib/auth', async () => {
  const { ApiError } = await import('@/lib/http');
  return {
    requireUser: () =>
      db.authThrows
        ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
        : Promise.resolve({ user: { id: 'user-a' }, session: { id: 'sess-1' } })
  };
});

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () =>
    db.preferencesThrows
      ? Promise.reject(new Error('数据库连接中断'))
      : Promise.resolve({ ...db.preferences })
}));

vi.mock('@/lib/prisma', async () => {
  const { createTable } = await import('./prisma-mock');
  const counted = (name: string, table: ReturnType<typeof createTable>) => ({
    ...table,
    count: (args?: { where?: Record<string, unknown> }) => {
      db.counts[name] = (db.counts[name] ?? 0) + 1;
      return table.count(args ?? {});
    }
  });
  return {
    prisma: {
      memoryItem: counted('memoryItem', createTable()),
      memoryCandidate: counted('memoryCandidate', createTable()),
      memoryPolicy: counted('memoryPolicy', createTable()),
      memoryRevision: counted('memoryRevision', createTable()),
      reflectionCitation: counted('reflectionCitation', createTable()),
      reflectionRecord: counted('reflectionRecord', createTable()),
      decisionRecord: counted('decisionRecord', createTable()),
      userProfileEntry: counted('userProfileEntry', createTable())
    }
  };
});

import { prisma } from '@/lib/prisma';
import { getCognitiveOverview } from '@/lib/cognitive/overview';
import { GET } from '@/app/api/account/cognitive/overview/route';

/** 替身表的把手：`...table` 把 rows 的引用带过来了，夹具直接往同一个 Map 里塞行。 */
const tables = prisma as unknown as Record<
  | 'memoryItem'
  | 'memoryCandidate'
  | 'memoryPolicy'
  | 'memoryRevision'
  | 'reflectionCitation'
  | 'reflectionRecord'
  | 'decisionRecord'
  | 'userProfileEntry',
  { rows: Map<string, Record<string, unknown>> }
>;

const ALL_ON = {
  memoryEnabled: true,
  userModelEnabled: true,
  emotionEnabled: true,
  associationEnabled: true,
  timelineEnabled: true,
  reflectionEnabled: true,
  decisionMemoryEnabled: true,
  adaptiveMemoryEnabled: true
};

function off(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return { ...ALL_ON, ...overrides };
}

function seedRows(table: { rows: Map<string, Record<string, unknown>> }, count: number, row: Record<string, unknown>) {
  for (let index = 0; index < count; index += 1) {
    const id = `row-${index}`;
    table.rows.set(id, { id, ...row });
  }
}

function reset() {
  for (const table of Object.values(tables)) table.rows.clear();
  db.counts = {};
  db.preferencesThrows = false;
  db.authThrows = false;
  db.preferences = { ...ALL_ON };
}

function section(overview: Overview, key: string): OverviewSection | undefined {
  return overview.sections.find((item) => item.key === key);
}

describe('门厅：七个入口、顺序、每条给什么', () => {
  beforeEach(reset);

  it('七个入口按任务书 8.2 列的顺序排，一个不多一个不少', async () => {
    const overview = await getCognitiveOverview('user-a');

    expect(overview.sections.map((item) => item.key)).toEqual([
      'graph',
      'timeline',
      'reflections',
      'decisions',
      'profile',
      'memory',
      'policy'
    ]);
  });

  it('每屏那句话就是库里数出来的条数，一个字的正文都不出去', async () => {
    seedRows(tables.memoryItem, 2, {
      userId: 'user-a',
      supersededAt: null,
      archivedAt: null,
      origin: 'EXPLICIT'
    });
    seedRows(tables.userProfileEntry, 1, { userId: 'user-a' });
    seedRows(tables.reflectionRecord, 3, { userId: 'user-a' });
    const overview = await getCognitiveOverview('user-a');

    expect(section(overview, 'memory')?.detail).toBe('2 条当前有效的记忆，另有 0 条等你确认');
    expect(section(overview, 'profile')?.detail).toBe('1 条画像');
    expect(section(overview, 'reflections')?.detail).toBe('3 条洞察');
    // 正文列根本没被读，序列化出来的对象里也不许有任何正文字段。
    expect(JSON.stringify(overview)).not.toMatch(/content|ciphertext|iv|tag|text|title/i);
  });

  it('数到超过那一屏的行数上限时，那句话自己说「只列出最近 N 条」', async () => {
    // 洞察一屏最多列 100 条。门厅报 101 而不带这句，用户点进去只会以为少了 1 条。
    seedRows(tables.reflectionRecord, 101, { userId: 'user-a' });
    const overview = await getCognitiveOverview('user-a');

    expect(section(overview, 'reflections')?.detail).toBe('101 条洞察（这一屏只列出最近 100 条）');
  });

  it('读不到偏好时五屏按关处理，但那两屏的数照给——它们本来就不看偏好', async () => {
    db.preferencesThrows = true;
    const overview = await getCognitiveOverview('user-a');

    expect(overview.preferencesUnavailable).toBe(true);
    expect(section(overview, 'graph')?.enabled).toBe(false);
    expect(section(overview, 'graph')?.detail).toBe(OVERVIEW_OFF);
    expect(db.counts.reflectionRecord).toBeUndefined();
    expect(db.counts.memoryRevision).toBeUndefined();
    // 片L：记忆管理和策略那两屏不以任何开关为条件，偏好读不出来更不是关掉它们的理由。
    expect(db.counts.memoryItem).toBe(1);
    expect(section(overview, 'memory')?.detail).toBe('0 条当前有效的记忆，另有 0 条等你确认');
  });
});

describe('闸门：关着的屏一次查询都不发', () => {
  beforeEach(reset);

  it('八个开关全关时，只有记忆管理和策略那三张表被数过', async () => {
    db.preferences = { ...ALL_ON };
    for (const key of Object.keys(ALL_ON)) db.preferences[key] = false;
    const overview = await getCognitiveOverview('user-a');

    // 片L 的裁决：这两屏关着也必须可达，所以它们的计数照发——
    // 「已经存下的还能看见、还能删」这件事的依据就是这几个数。
    expect(db.counts.memoryItem).toBe(1);
    expect(db.counts.memoryCandidate).toBe(1);
    expect(db.counts.memoryPolicy).toBe(1);
    // 其余五屏各自的表一次都不问。
    expect(db.counts.memoryRevision).toBeUndefined();
    expect(db.counts.reflectionCitation).toBeUndefined();
    expect(db.counts.reflectionRecord).toBeUndefined();
    expect(db.counts.decisionRecord).toBeUndefined();
    expect(db.counts.userProfileEntry).toBeUndefined();

    for (const key of ['graph', 'timeline', 'reflections', 'decisions', 'profile']) {
      expect(section(overview, key)?.enabled).toBe(false);
      expect(section(overview, key)?.detail).toBe(OVERVIEW_OFF);
    }
    // 那两屏不受牵连，照样给数。
    expect(section(overview, 'memory')?.enabled).toBe(true);
    expect(section(overview, 'policy')?.enabled).toBe(true);
  });

  it('记忆网络是两道闸：关联开着但长期记忆关着，一条引用边都不数', async () => {
    db.preferences = off({ memoryEnabled: false });
    const overview = await getCognitiveOverview('user-a');

    expect(db.counts.reflectionCitation).toBeUndefined();
    expect(section(overview, 'graph')?.enabled).toBe(false);
    expect(section(overview, 'graph')?.detail).toBe(OVERVIEW_OFF);
  });

  it('时间线同理：时间线开关开着但长期记忆关着，不数演化行', async () => {
    db.preferences = off({ memoryEnabled: false });
    await getCognitiveOverview('user-a');

    expect(db.counts.memoryRevision).toBeUndefined();
  });

  it('只关洞察一屏时，另外四屏照数：闸门是一屏一道，不是一关全灭', async () => {
    db.preferences = off({ reflectionEnabled: false });
    await getCognitiveOverview('user-a');

    expect(db.counts.reflectionRecord).toBeUndefined();
    expect(db.counts.decisionRecord).toBe(1);
    expect(db.counts.userProfileEntry).toBe(1);
    expect(db.counts.memoryRevision).toBe(1);
    expect(db.counts.reflectionCitation).toBe(1);
  });

  it('每屏的 enabled 就是那一屏路由自己的 409 条件：单独关掉时只有它变灰', async () => {
    const gates: Array<[string, string]> = [
      ['graph', 'associationEnabled'],
      ['timeline', 'timelineEnabled'],
      ['reflections', 'reflectionEnabled'],
      ['decisions', 'decisionMemoryEnabled'],
      ['profile', 'userModelEnabled']
    ];
    for (const [key, switchName] of gates) {
      reset();
      db.preferences = off({ [switchName]: false });
      const overview = await getCognitiveOverview('user-a');

      expect(section(overview, key)?.enabled, switchName).toBe(false);
      const others = overview.sections.filter((item) => item.key !== key);
      expect(others.filter((item) => !item.enabled).map((item) => item.key), switchName).toEqual([]);
    }
  });
});

describe('路由层', () => {
  beforeEach(reset);

  it('未登录 401，一次计数都不发', async () => {
    db.authThrows = true;
    const res = await GET(new Request('http://localhost/api/account/cognitive/overview'));

    expect(res.status).toBe(401);
    expect(db.counts.memoryItem).toBeUndefined();
  });

  it('全关也返回 200：这是门厅，不是某个模块的数据本身', async () => {
    db.preferences = off({ memoryEnabled: false, associationEnabled: false });
    const res = await GET(new Request('http://localhost/api/account/cognitive/overview'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sections: Array<{ key: string; detail: string }> } };
    expect(body.data.sections).toHaveLength(7);
    expect(body.data.sections.find((item) => item.key === 'graph')?.detail).toBe(OVERVIEW_OFF);
  });
});

describe('界面与接线：数字只能从接口来', () => {
  function panelSource(): string {
    return readFileSync(
      path.resolve(process.cwd(), 'src/components/settings/cognitive-overview-panel.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  function workspaceSource(): string {
    return readFileSync(
      path.resolve(process.cwd(), 'src/components/settings/settings-workspace.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('七个入口的中文标签都在，点一下切到对应那一屏', () => {
    const code = panelSource();
    for (const label of ['记忆网络', '认知时间线', 'AI 主动洞察', '决策记录', '画像', '记忆管理', '记忆策略']) {
      expect(code).toContain(label);
    }
    expect(code).toContain('onOpen');
  });

  it('那一行右侧的字直接来自接口的 detail，界面不许自己拼数字', () => {
    const code = panelSource();
    expect(code).toContain('section.detail');
    // 写在组件里的数只可能是猜的；这一屏也只该问门厅那一个接口。
    // 第一条管模板拼出来的假数，第二条管字面量——关着时补一个「0 条」也是替库里说话。
    expect(code).not.toMatch(/条记忆`/);
    expect(code).not.toMatch(/['"`]\d+\s*条/);
    expect(code).toContain('/api/account/cognitive/overview');
    expect(code).not.toMatch(/\/api\/account\/cognitive\/(memories|graph|timeline|reflections|profile)/);
  });

  it('这一屏不许出现任何开关：它只负责领路，改设置回到各屏去', () => {
    const code = panelSource();
    expect(code).not.toContain('type="checkbox"');
    expect(code).not.toContain('emotionEnabled');
    expect(code).not.toContain('PATCH');
  });

  it('门厅自己得在设置页里有个入口，否则它是一张进不去的屏', () => {
    const code = workspaceSource();
    expect(code).toContain('cognitive-overview-panel');
    expect(code).toContain("['overview', '认知中心'");
    // 左侧有那一行、tab 也认得，但主体没有渲染分支——点进去是一张空白屏。
    expect(code).toContain('<CognitiveOverviewPanel onOpen={setTab} />');
  });
});
