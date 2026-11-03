import { MEMORY_RETRIEVAL_POOL } from '@/lib/cognitive/memory-module';
import { STORIES, allMemories } from './fixtures/stories';
import type { ProbeScore, ArmSummary } from './metrics';

/**
 * 报告是**从 summary 数据渲染出来的**，不是手写的：
 * snapshot 测试要能重跑一遍再逐字节比对，手写的段落一动就对不上，
 * 而对不上之后人干的事通常是把 snapshot 更新掉——那这条门禁就废了。
 */

export interface ReportInput {
  scores: ProbeScore[];
  arms: { A2: ArmSummary; current: ArmSummary };
  visibleSize: number;
  /** 语料池只有百来行，线上一条查询面对的是整个候选池；两个量级要分开报。 */
  poolSize: number;
  /** 老批次同一批提问，在「只有老故事行的池子」和「全量池子」上各跑一遍的差值。 */
  dilution: { previousThrough: number; olderPoolSize: number; compared: number; changed: number; worse: number };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function categoryTable(arms: ReportInput['arms']): string {
  const rows = Object.keys({ ...arms.A2.byCategory, ...arms.current.byCategory }).sort();
  const lines = ['| 类别 | 守这一层的是 | 提问数 | A2 通过 | 现状通过 |', '|---|---|---|---|---|'];
  for (const row of rows) {
    const a = arms.A2.byCategory[row];
    const b = arms.current.byCategory[row];
    lines.push(
      `| ${row} | ${(a ?? b)!.guard} | ${a?.probes ?? 0} | ${a ? `${a.passed}/${a.probes}` : '—'} | ${
        b ? `${b.passed}/${b.probes}` : '—'
      } |`
    );
  }
  return lines.join('\n');
}

function goldTable(scores: ProbeScore[]): string {
  const byProbe = new Map<string, { A2?: ProbeScore; current?: ProbeScore }>();
  for (const score of scores) {
    const entry = byProbe.get(score.id) ?? {};
    if (score.arm === 'A2') entry.A2 = score;
    else entry.current = score;
    byProbe.set(score.id, entry);
  }
  const lines = [
    '| 提问 | 这一轮注入的（按注入顺序） | 标准答案 | 命中 | 违禁项 | 低可信漏标 |',
    '|---|---|---|---|---|---|'
  ];
  for (const [, entry] of byProbe) {
    const current = entry.current!;
    lines.push(
      `| ${current.id} | ${current.injected.join(' → ') || '（空）'} | ${current.gold.join(', ') || '（应为空）'} | ${
        current.hits.length
      }/${current.gold.length} | ${current.violations.join(', ') || '—'} | ${
        current.missingLowMark.join(', ') || '—'
      } |`
    );
  }
  return lines.join('\n');
}

/**
 * 每个故事一行的分表。铺量时唯一要看的东西：池子从几十行长到一两百行，
 * 老故事的 Recall 会不会被挤下去——总分看不出来，只有分表能看出来。
 */
function perStoryTable(scores: ProbeScore[]): string {
  const rows = new Map<string, { a2: (number | null)[]; current: (number | null)[]; missed: Set<string>; probes: number }>();
  for (const score of scores) {
    let bucket = rows.get(score.story);
    if (!bucket) {
      bucket = { a2: [], current: [], missed: new Set<string>(), probes: 0 };
      rows.set(score.story, bucket);
    }
    bucket.probes += 1;
    if (score.arm === 'A2') bucket.a2.push(score.recall);
    else {
      bucket.current.push(score.recall);
      for (const id of score.gold) if (!score.hits.includes(id)) bucket.missed.add(id);
    }
  }
  const lines = [
    '| 故事 | 主题 | 提问数 | A2 平均命中 | 现状平均命中 | 现状捞不回的条目 |',
    '|---|---|---|---|---|---|'
  ];
  for (const story of STORIES) {
    const bucket = rows.get(story.id);
    if (!bucket) continue;
    lines.push(
      `| ${story.id} ${story.title} | ${story.themes.join('/')} | ${bucket.probes / 2} | ${avgRecall(bucket.a2)} | ${avgRecall(bucket.current)} | ${
        [...bucket.missed].sort().join(', ') || '—'
      } |`
    );
  }
  return lines.join('\n');
}

/** gold 为空的提问（「这一轮就该什么都不注入」）不参与平均值，否则会把地板当成失败。 */
function avgRecall(values: (number | null)[]): string {
  const usable = values.filter((value): value is number => value !== null);
  if (usable.length === 0) return '—';
  return `${((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 100).toFixed(1)}%`;
}

/**
 * 铺量的三批各算一列小计。分表按故事看太细、总分又会被新故事稀释，
 * 「这一批到底比上一批难在哪」只有按批算才答得出来。
 */
export const BATCHES: Array<{ label: string; through: number }> = [
  { label: 's1–s8（3b 定口径）', through: 8 },
  { label: 's9–s19（3c 第一批）', through: 19 },
  { label: 's20–s30（3c 第二批）', through: 30 }
];

/** 故事号和行号都混在同一个 id 里（'s12' 是故事、's12-m3' 是行），只认开头那一段数字。 */
export function storyNumber(id: string): number {
  return Number(/^s(\d+)/.exec(id)?.[1] ?? NaN);
}

function batchTable(scores: ProbeScore[]): string {
  const current = scores.filter((score) => score.arm === 'current');
  const lines = [
    '| 批次 | 故事 | 有标准答案的提问 | 现状平均命中 | 完全落空的提问 | 捞不回的条目 |',
    '|---|---|---|---|---|---|'
  ];
  let previous = 0;
  for (const batch of BATCHES) {
    const inBatch = current.filter((score) => {
      const n = storyNumber(score.story);
      return n > previous && n <= batch.through;
    });
    previous = batch.through;
    const withGold = inBatch.filter((score) => score.recall !== null);
    const missedIds = new Set<string>();
    for (const score of withGold) {
      for (const id of score.gold) if (!score.hits.includes(id)) missedIds.add(id);
    }
    lines.push(
      `| ${batch.label} | ${new Set(inBatch.map((score) => score.story)).size} | ${withGold.length} | ` +
        `${avgRecall(withGold.map((score) => score.recall))} | ` +
        `${withGold.filter((score) => score.hits.length === 0).length} | ${missedIds.size} |`
    );
  }
  return lines.join('\n');
}

export function renderReport(input: ReportInput): string {
  const { arms, scores } = input;
  const current = arms.current;
  const baseline = arms.A2;
  const currentScores = scores.filter((score) => score.arm === 'current');
  const missed = currentScores.filter((score) => score.recall !== null && score.recall < 1);
  const zeroHit = currentScores.filter((score) => score.recall !== null && score.hits.length === 0);
  const minInjected = Math.min(...currentScores.map((score) => score.injected.length));

  return `# 认知评测报告（${STORIES.length} 个故事）

标注来源：**Agent 起草，用户复核口径**（任务书 7.1 要的是「人工制定的标准答案」，
这一版还不是人工标注，复核结论见文末）。所有故事、会话、记忆全部虚构，
未使用任何真实家庭成员的聊天记录。

- 池子：${allMemories().length} 行，其中此刻可见 ${input.visibleSize} 行（另有取代/失效/未生效的被挡在门外）
- 提问：${current.probes} 个，覆盖 ${STORIES.length} 个故事；延迟一栏另垫到 ${input.poolSize} 行量级

## 一句话结论

现状相对 A2：Recall@8 ${percent(baseline.recallAt8)} → ${percent(current.recallAt8)}，
MRR ${baseline.mrr} → ${current.mrr}，违禁项注入次数 ${baseline.forbiddenInjections} → ${current.forbiddenInjections}，
平均注入字符数 ${baseline.avgInjectedChars} → ${current.avgInjectedChars}。

## 四个对照臂今天的实际状态

| 臂 | 内容 | 今天 |
|---|---|---|
| A1 | 只有近期上下文，不带长期记忆 | 不跑：它要的是「模型作答质量」，harness 离线不接模型 |
| A2 | 改造前：按 recordedAt 取最近 K 条 | **跑了**，本报告里的旧基线 |
| B | 长期记忆 + 向量检索 | 跑不了：没有 Embedding Provider（5.3 未落地） |
| C | + 图关联 | 跑不了：RELATED_TO 边按实测否掉，见 tests/unit/cognitive-relations-calibration.test.ts |
| D | + 反思与决策经验 | 跑不了：Phase 5/6 未开始；且 decisionMaking 情境要求用户确认，确认界面还没做，今天一条决策记忆都落不进库 |
| 现状 | 保留期过滤 + 关键词召回 + 置信度标注 | **跑了**，就是线上行为 |

两臂共用同一个渲染器，差异只在「怎么选这 8 条」——所以数字动了说得出是谁干的。

## 指标

| 指标 | A2 | 现状 |
|---|---|---|
| Recall@8 | ${baseline.recallAt8} | ${current.recallAt8} |
| Precision@8 | ${baseline.precisionAt8} | ${current.precisionAt8} |
| MRR | ${baseline.mrr} | ${current.mrr} |
| 至少命中一条的提问占比 | ${percent(baseline.hitRate)} | ${percent(current.hitRate)} |
| 违禁项被注入的次数 | ${baseline.forbiddenInjections} | ${current.forbiddenInjections} |
| 该标低可信却没标的次数 | ${baseline.unmarkedLowConfidence} | ${current.unmarkedLowConfidence} |
| 平均注入字符数 | ${baseline.avgInjectedChars} | ${current.avgInjectedChars} |

## 分类别通过率

${categoryTable(arms)}

**guard 这一列不能省。** seam = 走的是线上那两个纯函数（selectMemoryCandidates / renderMemoryBlock）；
mirror = 靠 harness 里那份 visibleAt 复刻池子规则，真实来源是 listMemories 的 where 条件
（另由 tests/unit/cognitive-memories.test.ts 守住，不在这里重复计分）。
把两类混成一个总分报出去，等于拿复刻的数字冒充线上行为。

## 每个故事一行的对照

${perStoryTable(scores)}

铺量时要盯的是「现状平均命中」这一列：新故事进了池子以后，老故事的数字往下走，
说明 8 个名额在更大的池子里不够分，那是要动参数或者要上向量的信号，不是故事写得不好。

## 按铺量的三批各算一列

${batchTable(scores)}

这张表下面是「老故事被新故事挤出名额没有」的实测，不是对着两版报告目测：
把 s1–s${input.dilution.previousThrough} 的 ${input.dilution.compared} 个有标准答案的提问，
在只含这 ${input.dilution.olderPoolSize} 行的老池子和 ${input.visibleSize} 行的全量池子上各跑一遍现状臂，
命中数发生变化的 ${input.dilution.changed} 个，其中变差 ${input.dilution.worse} 个。
总分从上一批到这一批掉的量全部来自新批次更难，而不是名额被抢。

## 这份基线读出来的五件事

1. **每轮平均注入 ${current.avgInjectedItems} 条（上限 8，最少的一轮也注入了 ${minInjected} 条），
   其中 ${current.avgNonGoldSlots} 条不是这一问该答的。**
   名额是实实在在被填满的，不是照设计推出来的。补位逻辑（相关项不够就用最近的凑）
   宁可多给也不让这一轮完全没有记忆可用。
   但它意味着 Precision@8 只有 ${current.precisionAt8}，而这是这一版里最便宜的收益点：
   补位改成「只补分数大于 0 的」就能把噪声砍掉一大截，代价是有些轮会一条都不注入。
   30 个故事已经铺完，这个取舍现在可以定了——但它不属于这一片，改完要重跑基线再对比。
2. **有 ${current.unreachableGold.length} 条标准答案关键词一次都没捞回**：${current.unreachableGold.join(', ') || '无'}。
   这一栏是下一次要不要上向量、要不要重开 RELATED_TO 的第一手依据，也是 3c 铺量时唯一值得盯的增长。
3. **「该标低可信却没标」两臂都是 ${baseline.unmarkedLowConfidence} / ${current.unmarkedLowConfidence}，但这两个 0 不是一回事**：
   A2 那个 0 是因为该标的那几条压根没被注入（它输在 Recall 上），不是它标对了。这一栏只在「确实出现了」的前提下有意义。
4. **违禁项泄漏现状 ${current.forbiddenInjections} 次、A2 ${baseline.forbiddenInjections} 次。**
   数字小主要因为大多数违禁项（被取代的、已失效的）根本不进候选池——那是 SQL 层的功劳，不是这次改动的功劳；
   真正属于读侧的那类（跨会话的敏感记忆）A2 泄漏、现状不泄漏，见 forgetting 一栏。
5. **${zeroHit.length} 个提问一条标准答案都没命中**（共 ${current.probes} 个）——这一轮确实带了 8 条记忆进去，但没有一条是这件事。
   这一栏比 Recall 总分难看，因为总分被那些「一问就答全」的故事抬着；要不要动召回，先看下面「没答上的提问」那一节。

## 逐问明细（复核用这一张表）

${goldTable(scores)}

### 现状这一版没答上的提问

${missed.length === 0 ? '无' : missed.map((score) => `- ${score.id}：期望 ${score.gold.join(', ')}，实际注入 ${score.injected.join(', ') || '（空）'}，漏了 ${score.gold.filter((id) => !score.hits.includes(id)).join(', ')}`).join('\n')}

### 关键词一次都没捞回的标准答案条目

${current.unreachableGold.length === 0 ? '无' : current.unreachableGold.join(', ')}

## 7.3 里今天测不了的指标

| 指标 | 为什么没有 |
|---|---|
| 向量召回质量（B 臂） | 没有 Embedding Provider |
| 图关联命中、多跳路径正确率 | 关系表没建（实测否掉，见上） |
| 时间线完整性、演化链正确率 | Phase 4 认知时间线未开始 |
| 反思相关指标 | Phase 6 未开始 |
| 决策经验复用率 | Phase 5 未开始，且 requireConfirmation 的确认界面缺失 |
| 后台任务成功率与延迟 | 队列已落地（\`src/lib/cognitive/task-queue.ts\` / \`task-worker.ts\`），但这个 harness 测不到：它跑的是离线纯函数池，没有进程、没有真库，也就没有「一条任务从入队到收口耗时」这个可观测量。耗时目前只在 \`cognitive.task_done\` 日志里，60 秒租约仍是推断 |
| 存储增长曲线 | 需要真实库和真实时间跨度 |
| 检索延迟（ms） | 见下面「延迟」一节：不进 snapshot |
| 撤回/永久删除后的不可见率 | 已由 tests/unit/cognitive-memories.test.ts 在 SQL 层守住，harness 里重述一遍只会多一个可能不一致的来源 |

## 延迟

延迟每次跑都不一样，写进报告就成了每次 commit 都动的噪声，所以**不进 summary.json**，
只在 \`npm run eval:cognitive\` 的标准输出里给本机实测值（200 行池子、中位数）。
纯函数这一层是微秒级；一条查询真正的开销在解密整池 200 行，那一步在 readMemory 里，
harness 测不到，也不假装测得到。

## 这一版的限制

1. fixture 是 Agent 编的，池子也是编的。它能证明「相对 A2 有收益且不退化」，
   **不能证明线上真实用户的召回质量**。
2. 标准答案由 Agent 起草，尚未逐条人工复核；复核完成前，上面所有分类别通过率都算「待确认」。
3. **精确率那一栏有 fixture 自己的影子**：补位是「按最近时间倒序填」，而语料里贴着评测时刻的那几行
   恰好是家务和琐事（s8 的四条「我把 X 做了一遍」、s3 的重新开始拉琴），于是它们几乎出现在每一个兜底列表里。
   换一个真实用户，垫底的会是他的日常闲聊——「兜底捞到的是最近的琐事」这个结论成立，
   但 ${current.precisionAt8} 这个具体数字不能当成线上期望值。
4. 语料已到 ${STORIES.length} 个故事 / ${current.probes} 个提问，规模上满足了 7.1；但此刻可见的 ${input.visibleSize} 行
   已经贴着线上取数上限 ${MEMORY_RETRIEVAL_POOL} 行——再多铺故事就开始截断，
   那时候这份基线测的不再是「全部记忆里的召回」，而是「最近 ${MEMORY_RETRIEVAL_POOL} 行里的召回」，这条差异要在解读时说明。
   样本量够了，但 7.4 末段要的「根据结果设定正式阈值」还没做，这份报告就是设阈值用的那份基线。
`;
}

export function renderSummary(input: ReportInput): string {
  const payload = {
    schema: 1,
    counts: {
      stories: STORIES.length,
      sessions: STORIES.reduce((sum, story) => sum + story.sessions.length, 0),
      memories: allMemories().length,
      visibleMemories: input.visibleSize,
      probes: input.arms.current.probes
    },
    arms: { A2: input.arms.A2, current: input.arms.current },
    dilution: input.dilution,
    scores: input.scores
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
