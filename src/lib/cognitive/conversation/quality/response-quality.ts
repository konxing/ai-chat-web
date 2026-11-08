/**
 * 回答质量轻量检查（Phase 7）。纯程序规则，不调模型（计划书 9.2 / 11.1）。
 *
 * 只标记"明显的模板化/重复/无必要总结/违反格式"，不做语义审判；
 * 不用固定关键词一刀切禁止所有类似表达（ flag 仅供评测与统计，不直接拦截回答）。
 * 复杂任务的强检查（事实/论证/反例）留给 Phase 8 的独立评估，默认不每轮触发。
 */

export interface QualityFlags {
  templateOpening: boolean;
  mechanicalEnumerators: boolean;
  unnecessarySummary: boolean;
  repeatedSentence: boolean;
  listsWhenAskedNotTo: boolean;
  /** 0-1，越高越自然（模板化扣分）。 */
  naturalness: number;
  flags: string[];
}

const TEMPLATE_OPENINGS = /^(这是一个非常好的问题|好问题！|首先，|其次，|最后，|总的来说，)/;
const ENUMERATORS = /首先[，,].{0,80}其次[，,].{0,80}(最后|再次)[，,]/s;
const SUMMARY_TAIL = /(总之|综上所述|总而言之)[，,：:]/;
const LIST_LINE = /^\s*([-*•]|\d+[.、])\s+/m;

export function checkResponseQuality(input: {
  text: string;
  userAskedNoList?: boolean;
}): QualityFlags {
  const text = input.text.trim();
  const flags: string[] = [];

  const templateOpening = TEMPLATE_OPENINGS.test(text);
  if (templateOpening) flags.push('template_opening');

  const mechanicalEnumerators = ENUMERATORS.test(text);
  if (mechanicalEnumerators) flags.push('mechanical_enumerators');

  // 短回答却带总结尾 → 无必要总结。
  const unnecessarySummary = text.length < 200 && SUMMARY_TAIL.test(text);
  if (unnecessarySummary) flags.push('unnecessary_summary');

  // 同一句子重复出现 → 重复。
  const sentences = text.split(/[。！？!?\n]/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const seen = new Set<string>();
  let repeatedSentence = false;
  for (const s of sentences) {
    if (seen.has(s)) { repeatedSentence = true; break; }
    seen.add(s);
  }
  if (repeatedSentence) flags.push('repeated_sentence');

  const listsWhenAskedNotTo = Boolean(input.userAskedNoList) && LIST_LINE.test(text);
  if (listsWhenAskedNotTo) flags.push('lists_when_asked_not_to');

  const penalty =
    (templateOpening ? 0.2 : 0) +
    (mechanicalEnumerators ? 0.15 : 0) +
    (unnecessarySummary ? 0.15 : 0) +
    (repeatedSentence ? 0.2 : 0) +
    (listsWhenAskedNotTo ? 0.3 : 0);

  return {
    templateOpening,
    mechanicalEnumerators,
    unnecessarySummary,
    repeatedSentence,
    listsWhenAskedNotTo,
    naturalness: Math.max(0, 1 - penalty),
    flags
  };
}
