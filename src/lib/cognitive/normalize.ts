/**
 * 「同一句话」的归一化：空白、大小写和标点都不构成另一句话。
 *
 * 两个地方必须用同一套定义，所以只在这里写一份：
 * 一是写入决策判断「这是不是同一件事的新说法」（write-decision.findNearDuplicate），
 * 二是排除规则判断「这句是不是用户删掉过的那句」（exclusions.exclusionHash）。
 * 两边一旦漂移，用户删掉的内容换个标点就会被重新记回来。
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
