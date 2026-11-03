import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STORIES } from './fixtures/stories';
import { evaluate, measureLatency } from './evaluate';
import { renderReport, renderSummary } from './report';

/**
 * 入口：npm run eval:cognitive
 *
 * 落盘两份产物并提交进仓库——基线必须是能 diff 的东西，
 * 只存在某人本地的一次跑法，下一刀要不要上就又回到吵感觉。
 */

const OUT_DIR = path.resolve(process.cwd(), 'scripts/cognitive-eval');

const input = evaluate();
const latency = measureLatency();

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(input));
writeFileSync(path.join(OUT_DIR, 'summary.json'), renderSummary(input));

const current = input.arms.current;
const baseline = input.arms.A2;
console.log(
  [
    `${STORIES.length} 个故事、${current.probes} 个提问，此刻可见记忆 ${input.visibleSize} 行`,
    `Recall@8    A2 ${baseline.recallAt8} → 现状 ${current.recallAt8}`,
    `Precision@8 A2 ${baseline.precisionAt8} → 现状 ${current.precisionAt8}`,
    `MRR         A2 ${baseline.mrr} → 现状 ${current.mrr}`,
    `违禁项注入   A2 ${baseline.forbiddenInjections} → 现状 ${current.forbiddenInjections}`,
    `低可信漏标   A2 ${baseline.unmarkedLowConfidence} → 现状 ${current.unmarkedLowConfidence}`,
    `平均注入字符 A2 ${baseline.avgInjectedChars} → 现状 ${current.avgInjectedChars}`,
    `检索纯函数延迟（${latency.poolSize} 行池子，201 次中位数）${latency.medianMicros} µs；不含解密整池那一步`,
    '',
    '报告：scripts/cognitive-eval/report.md',
    '数据：scripts/cognitive-eval/summary.json'
  ].join('\n')
);
