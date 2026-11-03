import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 认知评测基线的门禁（任务书 7.4 末段：先运行基线，再根据结果设定正式阈值）。
 *
 * 它不重新发明指标，只做一件事：**在进程里重跑一遍 harness，和提交进仓库的那份逐字节比对。**
 * 于是任何人改了召回参数、池子大小、保留期默认值或者渲染格式，数字一动这个测试就红——
 * 他要做的不是把测试改绿，而是带着那份 diff 显式更新基线并说明为什么这版更好。
 * 「没有实测收益的模块不应默认启用」这条规则，落地就落在这里。
 *
 * fixture 的自查也在这一跑里：正文必须逐字出自声明的会话、重复陈述次数不许虚报。
 * 那两条要是松了，下面这些数字就全是在给一份没人核对过的标注背书。
 */

import { evaluate, measureLatency } from '../../scripts/cognitive-eval/evaluate';
import { renderReport, renderSummary } from '../../scripts/cognitive-eval/report';
import { selfCheck } from '../../scripts/cognitive-eval/harness';

const DIR = path.resolve(process.cwd(), 'scripts/cognitive-eval');

describe('认知评测基线', () => {
  it('fixture 自查一条问题都没有', () => {
    expect(selfCheck()).toEqual([]);
  });

  it('summary.json 与重跑的结果逐字节一致', () => {
    const committed = readFileSync(path.join(DIR, 'summary.json'), 'utf8');

    expect(renderSummary(evaluate())).toBe(committed);
  });

  it('report.md 与重跑的结果逐字节一致', () => {
    const committed = readFileSync(path.join(DIR, 'report.md'), 'utf8');

    expect(renderReport(evaluate())).toBe(committed);
  });

  it('现状不许比改造前的基线更差', () => {
    const { arms } = evaluate();

    expect(arms.current.recallAt8).toBeGreaterThanOrEqual(arms.A2.recallAt8);
    expect(arms.current.mrr).toBeGreaterThanOrEqual(arms.A2.mrr);
    expect(arms.current.forbiddenInjections).toBeLessThanOrEqual(arms.A2.forbiddenInjections);
    expect(arms.current.unmarkedLowConfidence).toBe(0);
  });

  it('检索纯函数在 200 行池子上仍然是微秒级', () => {
    const latency = measureLatency(51);

    // 这条断言守的是量级，不是具体毫秒：真在线上的开销大头是解密整池，那不在这个函数里。
    expect(latency.poolSize).toBe(200);
    expect(latency.medianMicros).toBeLessThan(2000);
  });

  it('稀释那一栏是在两个真池子之间比出来的，不是拿空池子凑的', () => {
    // 老批次池子按 id 前缀切出来。切错的话 olderPoolSize 会是 0，
    // 于是「命中数变化 0 个」这种漂亮结论会由一个空对照悄悄成立。
    const { dilution, visibleSize } = evaluate();

    expect(dilution.olderPoolSize).toBeGreaterThan(0);
    expect(dilution.olderPoolSize).toBeLessThan(visibleSize);
    expect(dilution.compared).toBeGreaterThan(0);
  });
});
