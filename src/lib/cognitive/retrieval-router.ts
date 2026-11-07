/**
 * 按需召回路由（混合式记忆升级 Phase 4，任务书第六章「情境性召回」）。
 *
 * 在模型生成前判断这一轮要不要历史记忆：普通知识问答 / 翻译 / 简单数学不该注入一堆用户个人信息，
 * 既费 token 又可能把无关记忆塞进上下文。涉及用户自己的事（「我的项目」「我之前说过」）才召回。
 *
 * 纯函数、低成本、不调模型（任务书 9.4「先判断是否需要记忆，优先低成本过滤」）。
 * 保守原则：拿不准就召回（'light'），宁可多带一条相关记忆，也不漏掉用户真正在问的历史。
 * 只有**明确是 impersonal 的知识/翻译/数学**才判 'none'。
 *
 * 测试：tests/unit/cognitive-retrieval-router.test.ts
 */

export type RetrievalNeed = 'none' | 'light' | 'complex';

export interface RetrievalRoute {
  need: RetrievalNeed;
  reason: 'personal' | 'personal_complex' | 'generic_knowledge' | 'default';
}

/** 第一人称/自身指代：出现这些就是在问用户自己的事，需要个人记忆。 */
const PERSONAL_RE = /我|咱|俺|自己|我的/;

/** 跨会话综合分析：在个人指代基础上命中这些，允许更复杂的混合检索/图关联。 */
const COMPLEX_RE = /分析|比较|总结|回顾|反思|变化|长期|这些年|过去.*决策|兴趣.*变/;

/** 明确的 impersonal 知识/翻译/数学说法（不带第一人称时才判 none）。 */
const GENERIC_RE =
  /^(什么是|什么叫|解释一下|解释|翻译|计算|算一下|请问)|翻译|等于多少|等于几|是多少|\d+\s*[加减乘除+×*/-]\s*\d+|怎么(做|写|实现|用|读)|如何(做|写|实现|使用)|为什么/;

export function routeMemoryRetrieval(query: string): RetrievalRoute {
  const text = query.trim();
  if (PERSONAL_RE.test(text)) {
    return COMPLEX_RE.test(text)
      ? { need: 'complex', reason: 'personal_complex' }
      : { need: 'light', reason: 'personal' };
  }
  if (GENERIC_RE.test(text)) {
    return { need: 'none', reason: 'generic_knowledge' };
  }
  // 拿不准：保守召回，不漏掉可能的个人历史。
  return { need: 'light', reason: 'default' };
}