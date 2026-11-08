import { allProbes } from './fixtures/stories';
import { buildPool, EVAL_NOW } from './harness';
import { selectMemoryCandidates } from '@/lib/cognitive/memory-module';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { verificationBlocksRecall } from '@/lib/cognitive/memory-verification';
import type { MemoryDto } from '@/lib/cognitive/memories';

type Arm = 'stateless' | 'legacy' | 'strict';
const pool = buildPool();
const probes = allProbes().map((value) => value.probe);

function select(arm: Arm, query: string, session: string, memories: MemoryDto[]): MemoryDto[] {
  if (arm === 'stateless') return [];
  return selectMemoryCandidates({
    query, rows: memories, policies: DEFAULT_MEMORY_POLICIES,
    chatId: session, now: EVAL_NOW, strictRelevance: arm === 'strict',
    limit: 8
  });
}

function evaluateArm(arm: Arm) {
  let eligible = 0, gold = 0, hit = 0, predictions = 0, forbidden = 0, chars = 0;
  for (const probe of probes) {
    const predicted = select(arm, probe.query, probe.session, pool);
    const ids = new Set(predicted.map((r) => r.id));
    if (probe.gold.length) eligible += 1;
    gold += probe.gold.length;
    hit += probe.gold.filter((id) => ids.has(id)).length;
    predictions += predicted.length;
    forbidden += (probe.forbidden ?? []).filter((id) => ids.has(id)).length;
    chars += predicted.reduce((total, memory) => total + memory.content.length, 0);
  }
  return {
    arm, probes: probes.length, questionsWithGold: eligible,
    recallAt8: gold ? +(hit / gold).toFixed(4) : null,
    precisionAt8: predictions ? +(hit / predictions).toFixed(4) : null,
    forbiddenInjections: forbidden,
    averageEvidenceCharacters: probes.length ? Math.round(chars / probes.length) : 0
  };
}

/** Deterministic injected-error probes; no real user data or model services are used. */
const injectedErrors = [
  { state: 'REFUTED', expiresAt: null },
  { state: 'DISPUTED', expiresAt: null },
  { state: 'VERIFIED', expiresAt: new Date(EVAL_NOW.getTime() - 60_000) }
];
const rejectedInjectedErrors = injectedErrors.filter(({ state, expiresAt }) =>
  verificationBlocksRecall(state, expiresAt, EVAL_NOW)
).length;

console.log(JSON.stringify({
  disclaimer: '离线纯函数检索评测。不能代表模型最终回答准确率、真实数据库隔离或 Wiki/Dreaming 线上表现。',
  models: ['stateless', 'legacy', 'strict'].map((arm) => evaluateArm(arm as Arm)),
  injectedErrorCases: injectedErrors.length,
  injectedErrorRejected: rejectedInjectedErrors,
  fixtureSource: 'scripts/cognitive-eval/fixtures (fictional, not user conversations)'
}, null, 2));
