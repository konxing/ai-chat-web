import type { MemoryDto } from './memories';

/**
 * 记忆衰减（混合式记忆升级 Phase 5，任务书第七章）。
 *
 * 借鉴人类记忆「久未使用的信息召回优先级下降」，但守住两条红线：
 * 一、**衰减只改召回优先级，不删历史事实**（7.1）。重要经历不会因为久未检索就被抹掉。
 * 二、**衰减不等于可信度下降**（7.1）：这里算的是「这一轮该不该优先带它」，不是「它还可不可信」。
 *
 * 用现有字段派生，不加列、无迁移：
 * - 时间新近度（recordedAt）：越新越高，温和衰减（30 天半衰量级），主分量——保证同分时仍 newest-first。
 * - 用户确认（confirmedAt）：确认过的略加分，稳定认知优先。
 * - 类型稳定性：事实/偏好这类语义/程序性记忆衰减更慢（7.2），略加分。
 *
 * 访问频率刻意不进来：任务书 7.3 说访问频率只能作辅助信号、不能解释为真实性，且读它要多查一张表，
 * 落在每轮关键路径上不划算。这一版只用零额外读取的字段。
 *
 * 测试：tests/unit/cognitive-memory-decay.test.ts
 */

const DAY_MS = 86_400_000;

/**
 * 是否把衰减接进读侧排序。默认关：实测（cognitive-eval-snapshot / salience-calibration）显示
 * 当前衰减 tie-break 会把 Recall@8 从 0.7274 拉到 0.7181——没有实测收益反而退步，按任务书
 * 「没有实测收益的模块不应默认启用」保持关闭。衰减分本身可用，待更好的设计（不 bury 相关旧记忆）
 * 再开启。env `COGNITIVE_MEMORY_DECAY=1` 启用。
 */
export function memoryDecayEnabled(): boolean {
  return process.env.COGNITIVE_MEMORY_DECAY === '1';
}

export function decayPriority(memory: MemoryDto, now: Date): number {
  const recorded = Date.parse(memory.recordedAt);
  const ageDays = Number.isFinite(recorded) ? Math.max(0, (now.getTime() - recorded) / DAY_MS) : 0;
  // 温和衰减：新记忆接近 1，越久越趋近 0，但永不归零（历史事实始终有机会被召回）。
  const recency = 1 / (1 + ageDays / 30);
  const confirmationBoost = memory.confirmedAt ? 0.15 : 0;
  const stabilityBoost = memory.type === 'fact' || memory.type === 'preference' ? 0.05 : 0;
  return recency + confirmationBoost + stabilityBoost;
}