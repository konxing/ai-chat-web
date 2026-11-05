import { CONFIDENCE_BAND_LABELS, formatDate } from './memory-display';
import type { MemoryDto } from './memories';
import type { ConfidenceBand } from './confidence';

/**
 * 聊天里那句「这一轮带上了哪几条记忆」（任务书 8.2）。
 *
 * 措辞和行形状全在这个纯模块里，理由与 memory-display.ts 同一份：气泡是客户端组件，
 * 而记忆正文与置信度都在 import 了 prisma 的服务层。边界由
 * tests/unit/cognitive-citation-display.test.ts 最后那条静态断言钉住。
 *
 * 那句说明不许写成「AI 根据这些记忆回答」：我们能证明的只有「这些东西被塞进了这一轮的上下文」，
 * 模型到底用没用、怎么用，服务端一个字都不知道。任务书的原则是同一条——不能让推断冒充事实。
 */

/** 展开区顶部那句：说清这个数字凭什么。 */
export const CITATION_NOTE = '这只是这一轮随问题一起交给模型的资料，不代表模型按它回答了。';

/**
 * 引用的那条已经不在了。这一行不许省：数字是注入那一刻算的，点开却是现在这一刻的列表，
 * 中间用户删过、改过口或收起来过，两边就对不上——对不上要说清是对不上，而不是默默少列一条。
 */
export const CITATION_MISSING_LABEL = '这条记忆已不在你的有效记忆里（可能已被更新、删除或归档）';

/**
 * 点开时那一次读失败的说法。这句不许留在组件里：它是这一屏唯一一处「东西没拿到」的坦白，
 * 字面要和上面两句一样由用例逐字钉住。
 */
export const CITATION_LOAD_FAILED_NOTE = '这条清单没读到，稍后再试试';

/** 收起态那一句。0 条给空串，让界面什么都不渲染，而不是摆一个点开是空的控件。 */
export function citationHint(count: number): string {
  if (count <= 0) return '';
  return `这一轮带上了 ${count} 条长期记忆`;
}

export interface CitationRow {
  id: string;
  /** 记忆正文，或者那句「已不在有效记忆里」的说明。 */
  text: string;
  /** 记于哪天、可信度档位、来源会话；缺哪一段就不写哪一段。 */
  meta: string;
  missing: boolean;
}

export interface CitationInput {
  /** 注入那一刻交出来的 id，顺序就是它们进提示词的顺序。 */
  ids: readonly string[];
  /** 现在这份有效记忆列表——引用是过去那一刻的事，列表是现在的，两者会错位。 */
  memories: readonly MemoryDto[];
  /** 会话 id → 标题，来自同一个接口的旁表。 */
  chats: Record<string, string>;
  /** 记忆 id → 置信档位，同样来自旁表；算不出就按低报。 */
  confidence: Record<string, { band: ConfidenceBand }>;
}

/** 按 id 逐条配出现在的列表里；配不上的不丢，单独成一行说明。 */
export function citationRows(input: CitationInput): CitationRow[] {
  const byId = new Map(input.memories.map((memory) => [memory.id, memory]));
  return input.ids.map((id) => {
    const memory = byId.get(id);
    if (!memory) return { id, text: CITATION_MISSING_LABEL, meta: '', missing: true };
    // 「记于」说的是这条记忆被记下来的那天，不是它所描述的事情发生的时刻——后者是有效区间那一段的事。
    const parts = [
      `记于 ${formatDate(memory.recordedAt, 'day')}`,
      CONFIDENCE_BAND_LABELS[input.confidence[id]?.band ?? 'low']
    ];
    const title = memory.chatId ? input.chats[memory.chatId] : undefined;
    if (title) parts.push(`来自《${title}》`);
    return { id, text: memory.content, meta: parts.join(' · '), missing: false };
  });
}
