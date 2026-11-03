import { allProbes } from './fixtures/stories';
import { selectMemoryCandidates } from '@/lib/cognitive/memory-module';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { buildPool, EVAL_NOW, paddedPool, runProbe, selfCheck } from './harness';
import type { ProbeScore, ArmSummary } from './metrics';
import { scoreProbe, summarizeArm } from './metrics';
import { BATCHES, storyNumber } from './report';
import type { ReportInput } from './report';

/**
 * 一次完整的离线评测：先自查 fixture，再让两个臂各答一遍所有提问。
 * 不写文件、不测延迟——这两件事留给 run.ts，snapshot 测试要的是能重跑且逐字节相同的那部分。
 */

/** 线上一条查询面对的是整个候选池，评测的延迟也就按那个量级垫。 */
export const MEASURED_POOL_SIZE = 200;

export function evaluate(): ReportInput {
  const problems = selfCheck();
  if (problems.length > 0) {
    const detail = problems.map((problem) => `${problem.where}: ${problem.message}`).join('\n  ');
    throw new Error(`fixture 自查没通过，指标不能用：\n  ${detail}`);
  }

  const pool = buildPool();
  const scores: ProbeScore[] = [];
  for (const { probe } of allProbes()) {
    scores.push(scoreProbe(runProbe(pool, probe, 'A2')));
    scores.push(scoreProbe(runProbe(pool, probe, 'current')));
  }

  const arms: { A2: ArmSummary; current: ArmSummary } = {
    A2: summarizeArm(scores.filter((score) => score.arm === 'A2')),
    current: summarizeArm(scores.filter((score) => score.arm === 'current'))
  };
  return {
    scores,
    arms,
    visibleSize: pool.length,
    poolSize: MEASURED_POOL_SIZE,
    dilution: measureDilution(pool, scores)
  };
}

/**
 * 老故事有没有被新故事挤出 8 个名额——「稀释」的直接读数。
 *
 * 做法是把同一批提问在「只含老故事行的池子」和「全量池子」上各跑一遍现状臂，
 * 逐问比命中数。这一版的读数要是负的，就说明铺量铺到某个规模后必须动 K 或者上向量，
 * 而不是继续加故事。
 */
function measureDilution(pool: ReturnType<typeof buildPool>, scores: ProbeScore[]): ReportInput['dilution'] {
  const previousThrough = BATCHES.slice(0, -1).at(-1)!.through;
  const olderPool = pool.filter((memory) => storyNumber(memory.id) <= previousThrough);
  const probes = new Map(allProbes().map((entry) => [entry.probe.id, entry.probe]));
  let compared = 0;
  let changed = 0;
  let worse = 0;
  for (const score of scores) {
    if (score.arm !== 'current' || score.recall === null || storyNumber(score.story) > previousThrough) continue;
    const before = scoreProbe(runProbe(olderPool, probes.get(score.id)!, 'current'));
    compared += 1;
    if (before.hits.length !== score.hits.length) {
      changed += 1;
      if (score.hits.length < before.hits.length) worse += 1;
    }
  }
  return { previousThrough, olderPoolSize: olderPool.length, compared, changed, worse };
}

/**
 * 纯函数那一层的检索延迟：把池子垫到 200 行，跑若干轮取中位数。
 *
 * 这个数只描述 selectMemoryCandidates 自己，不含解密——线上真正的大头是把 200 行密文
 * 解成明文再比，那一步在 readMemory 里，harness 够不着。报的时候要带着这句话，
 * 不然一个几微秒的数会被当成「整条记忆链路的开销」。
 */
export function measureLatency(runs = 201): { medianMicros: number; poolSize: number } {
  const pool = paddedPool(buildPool(), MEASURED_POOL_SIZE);
  const probes = allProbes();
  const samples: number[] = [];

  for (let round = 0; round < runs; round += 1) {
    const probe = probes[round % probes.length]!.probe;
    const started = process.hrtime.bigint();
    selectMemoryCandidates({
      query: probe.query,
      rows: pool,
      policies: DEFAULT_MEMORY_POLICIES,
      chatId: probe.session,
      now: EVAL_NOW
    });
    samples.push(Number(process.hrtime.bigint() - started) / 1000);
  }
  samples.sort((left, right) => left - right);
  return { medianMicros: Math.round(samples[Math.floor(samples.length / 2)]!), poolSize: pool.length };
}
