import type { MemoryOrigin } from './memories';

/**
 * 置信度评分（任务书 2.2）。
 *
 * 明令禁止的是「LLM 随口生成的数字」，所以这里是一个确定性纯函数：
 * 同样的输入永远得到同样的分数，而 factors 就是那份说明书——每一分都能指出是哪个因子给的，
 * 界面直接把它翻译成中文显示。分数本身不出服务端，对外只给档位：
 * 一个三位小数会被当成精确真理，而它只是规则的产物。
 *
 * 四个因子对应任务书点名的四样：
 * 来源可靠程度（origin 基线）、独立证据数量（重复陈述，有封顶）、
 * 冲突情况（反对证据，重罚且封档）、时间有效性（已过有效期直接归零）。
 *
 * 重复陈述的加分刻意封顶：说十遍不比说四遍更真。
 * 而 7.1 写明的「检索次数不能直接提高事实可信度」在这里体现为——被反复用到不算证据，
 * 只有用户又原话说了一遍才算，而且算得有限。
 *
 * 置信度不落库：存一列就要维护刷新时机，漏一处就是一个过期的假数字。读时算，永远一致。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-confidence.test.ts
 */

export type ConfidenceBand = 'low' | 'medium' | 'high';

/** 因子是结构化的，中文标签在 memory-display.ts 里——那是纯模块，客户端组件才能引用。 */
export type ConfidenceFactor =
  | { kind: 'origin'; origin: MemoryOrigin }
  | { kind: 'restated'; count: number }
  | { kind: 'contradicted'; count: number }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'retracted' };

export interface ConfidenceInput {
  origin: MemoryOrigin;
  confirmedAt: string | null;
  supersededAt: string | null;
  /** 事实失效时间；已经过了就不再是当前有效的事实。 */
  validTo: string | null;
  /** 支持证据总条数，含记忆创建时那一条——那一条就是基线本身，不重复计分。 */
  supports: number;
  contradicts: number;
  now: Date;
}

export interface Confidence {
  score: number;
  band: ConfidenceBand;
  factors: ConfidenceFactor[];
}

const ORIGIN_BASE: Record<MemoryOrigin, number> = {
  userConfirmed: 0.75,
  explicit: 0.6,
  observed: 0.4,
  inferred: 0.25,
  hypothesis: 0.15,
  retracted: 0
};

const RESTATED_BONUS = 0.08;
const RESTATED_MAX_COUNTED = 3;
const CONTRADICTION_PENALTY = 0.25;
const CONFIRMED_BONUS = 0.05;
const SUPERSEDED_SCORE = 0.1;
const HIGH_BAND = 0.75;
const MEDIUM_BAND = 0.45;

export function assessConfidence(input: ConfidenceInput): Confidence {
  const retracted = input.origin === 'retracted';
  const expired = input.validTo !== null && new Date(input.validTo).getTime() <= input.now.getTime();
  const superseded = input.supersededAt !== null;

  // 终态排在最前面：那是关于这条记忆最重要的事实，界面上要先看到它。
  const factors: ConfidenceFactor[] = [];
  if (retracted) factors.push({ kind: 'retracted' });
  if (expired) factors.push({ kind: 'expired' });
  if (superseded) factors.push({ kind: 'superseded' });
  factors.push({ kind: 'origin', origin: input.origin });

  const restatements = Math.max(0, input.supports - 1);
  if (restatements > 0) factors.push({ kind: 'restated', count: restatements });
  if (input.contradicts > 0) factors.push({ kind: 'contradicted', count: input.contradicts });

  if (retracted || expired) return { score: 0, band: 'low', factors };
  // 被取代的旧版本不参与加分：它已经不是当前说法了，留着 0.1 只是为了在版本链里
  // 不和「彻底不可信」画等号。
  if (superseded) return { score: SUPERSEDED_SCORE, band: 'low', factors };

  let score = ORIGIN_BASE[input.origin];
  // 只有用户亲手确认过的那一档才给这个加成：explicit 本来就带确认时间，
  // 再给一次等于把同一件事算两遍。
  if (input.origin === 'userConfirmed' && input.confirmedAt) score += CONFIRMED_BONUS;
  score += Math.min(restatements, RESTATED_MAX_COUNTED) * RESTATED_BONUS;
  score -= input.contradicts * CONTRADICTION_PENALTY;
  score = Math.min(1, Math.max(0, score));

  // 有冲突就封在低档：分数再高也不能让一条自相矛盾的记忆以确定的口气进提示词。
  const band: ConfidenceBand =
    input.contradicts > 0 ? 'low' : score >= HIGH_BAND ? 'high' : score >= MEDIUM_BAND ? 'medium' : 'low';
  return { score, band, factors };
}
