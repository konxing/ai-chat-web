import {
  registerCognitiveModule,
  type CognitiveBlock,
  type CognitiveModule,
  type CognitiveTurn
} from './manager';
import { extractMemoryCandidates, MEMORY_CANDIDATES_PER_TURN } from './memory-extractor';
import { aiMemoryExtractionEnabled, refineCandidatesWithAI, resolveMemoryExtractionProvider } from './memory-extractor-ai';
import { decisionModule } from './decision-module';
import { userModelModule } from './user-model-module';
import { CONTEXT_LABELS, ORIGIN_LABELS, TYPE_LABELS, describeValidRange } from './memory-display';
import { createMemory, listMemories, reviseMemory, attachMemoryVector } from './memories';
import { expandRelatedMemories, RELATION_TYPE_LABELS, type RelatedMemoryHit } from './relations';
import { embedMemoryText } from './embedding';
import { assessMemories, recordEvidenceOutsideTransaction } from './evidence';
import { excludedHashes, exclusionHash } from './exclusions';
import { log } from '@/lib/logger';
import { getMemoryPolicies } from './policy';
import type { MemoryContext, MemoryPolicy } from './policy';
import type { Confidence } from './confidence';
import { getCognitivePreferences, type EmotionTransparency } from './preferences';
import { rankMemories, rankMemoriesHybrid, scoreByKeyword, type NumericVector } from './retrieval';
import { decayPriority, memoryDecayEnabled } from './memory-decay';
import { isMemoryUsable } from './retention';
import { findNearDuplicate, planMemoryWrite } from './write-decision';
import { proposeCandidate } from './memory-candidates';
import { resolveTemporalFrame } from './temporal';
import { routeMemoryRetrieval } from './retrieval-router';
import {
  LOW_CONFIDENCE_MARKER,
  MEMORY_FRAMING,
  emotionTransparencyNote,
  renderFramingHeader
} from './response-policy';
import type { MemoryDto, MemoryOrigin } from './memories';

/**
 * 记忆模块本体（③：让策略真正跑在对话链路上）。
 *
 * 读：按这一轮的提问召回记忆（关键词重合度，不是时间倒序），过掉不在保留期内的，
 * 再渲染成一段「数据不是指令」的文本交给上下文构建。
 * 写：抽候选 → 跳过用户永久删除过的 → 分类情境 → 按该情境的策略决定留不留，
 * WRITE 落新行、UPDATE 走演化、ASK_CONFIRM 进待确认候选。
 * 测试：tests/unit/cognitive-memory-module.test.ts、tests/unit/cognitive-chat-wiring.test.ts
 *
 * 读侧的「过滤 + 召回」和「渲染」各自是一个纯函数（selectMemoryCandidates / renderMemoryBlock），
 * 中间只夹一次算置信度的查询。拆开不是为了整洁，是为了认知评测 Harness 能在离线喂 fixture 跑同一条路径；
 * 它不测 readMemory 那三行取数，那三行由上面的模块测试守着。
 * 为什么不是「一个」纯函数：那样得把整池 200 行的证据计数一次查出来，
 * 而今天只查选中的 8 条——一次 IN (200) 换不来任何东西。
 *
 * LINK 与 DELETE 在写入决策里仍然没有分支，但「建立关联」已经有真实生产者：
 * 同主题边由这一片的写侧在同一个事务里落库（relations.ts），演化边由 reviseMemory 落库；
 * 读侧的两跳扩展受 associationEnabled 控制。DELETE 仍然只走用户点出来的三种忘记——
 * 让模型自己决定「永久删除」不在这一版的授权范围内。
 * ASK_CONFIRM 有分支（片M）：它写进待确认候选表，用户点「记住」之后才成为记忆——
 * 在此之前这句话在任何读路径上都看不见，所以它既不是「记住了」也不是「问过了」，它是「在等用户回答」。
 */
export const MEMORY_READ_MAX_ITEMS = 8;
export const MEMORY_READ_MAX_CHARS = 1500;
export const MEMORY_WRITE_MAX_PER_TURN = 2;

/**
 * 关键词召回的候选池大小，等于服务层 listMemories 的硬上限。
 *
 * 正文是密文，SQL 层看不到明文，所以召回只能在应用层解密之后比——池子必须整个捞回来。
 * 池子只取最近几条的话，关键词召回就没东西可召回：改造前那个「按 recordedAt 取前 8 条」
 * 的病根正是池子太小又太偏。代价是每轮最多解密 200 行，实测数字见 commit message。
 */
export const MEMORY_RETRIEVAL_POOL = 200;

/** 演化原因里不放正文：新旧正文各自在自己的行上，这里只回答「为什么改」。 */
const SUPERSEDE_REASON = '用户在后续对话中再次提到这件事，按新版本处理';

const MEMORY_TEXT_HEADER = renderFramingHeader(MEMORY_FRAMING);
/** 关联扩展那几行的抬头。它和种子正文共用字符预算，抬头本身也占位。 */
const RELATED_BLOCK_HEADER = '相关记忆（由已选记忆的关系扩展而来，仍只是参考资料）：';

/** 忽略空白和大小写后相同，就认为是同一句话——重复陈述不该变成第二条记忆。 */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

async function readMemory(turn: CognitiveTurn): Promise<CognitiveBlock[]> {
  const now = new Date();
  // 按需召回路由（Phase 4）：纯知识/翻译/数学问题不注入个人记忆，连记忆池都不读，省 token。
  // 涉及用户自己的事照常召回；拿不准保守召回。路由是纯函数，落在任何数据库读之前。
  if (routeMemoryRetrieval(turn.content).need === 'none') return [];
  // 候选池是当前有效的全部记忆（上限 MEMORY_RETRIEVAL_POOL 行），排序交给关键词召回。
  const rows = await listMemories(turn.userId, { asOf: now, take: MEMORY_RETRIEVAL_POOL });
  if (rows.length === 0) return [];

  // 策略表读失败就让这个模块整体失败（manager 会隔离并记一条不含正文的告警）：
  // 读不到保留期就注入，等于把用户设成「30 天」的记忆又端回模型面前，宁可这一轮不带记忆。
  const policies = await getMemoryPolicies(turn.userId);
  // 偏好读一次，两个值一起用：检索条数上限管选几条，associationEnabled 管要不要扩关联。
  // 读失败就让模块失败（manager 隔离），而不是退回默认值替用户改设置。
  const preference = await getCognitivePreferences(turn.userId);
  const emotionTransparency = turn.emotionTransparency ?? 'implicit';
  const memories = selectMemoryCandidates({
    query: turn.content,
    rows,
    policies,
    chatId: turn.chatId,
    now,
    emotionTransparency,
    emotionEnabled: turn.emotionEnabled,
    limit: preference.memoryReadLimit
  });
  // 关联扩展是 associationEnabled 的运行时读者：关着时连关系表都不问。
  // 扩展目标只从这一轮已经取回的可见池里出，所以不会把失效行捞回上下文。
  let related: RelatedMemoryHit[] = [];
  if (memories.length > 0 && preference.associationEnabled) {
    related = await expandRelatedMemories({
      userId: turn.userId,
      seeds: memories,
      rows,
      policies,
      chatId: turn.chatId,
      now,
      emotionEnabled: turn.emotionEnabled,
      emotionTransparency
    });
  }
  // 种子和关联扩展一起算分：一条记忆作种子注入时带着低可信度标注，被关系边捞进来时
  // 也必须带——不然低凭据记忆可以稳定地以「相关记忆」身份绕过标注（任务书 3.3）。
  const confidence = await assessMemories(
    turn.userId,
    [...memories, ...related.map((hit) => hit.memory)],
    now
  );
  return renderMemoryBlock(memories, confidence, emotionTransparency, related);
}

export interface MemorySelectionInput {
  /** 用户这一轮说的话，召回的相关度就是照着它算的。 */
  query: string;
  rows: readonly MemoryDto[];
  policies: Record<MemoryContext, MemoryPolicy>;
  chatId: string;
  now: Date;
  /**
   * 查询串的向量。给了才走混合排序，不给就还是纯关键词。
   * 这里刻意不自己去算：那是一次出站请求，落在每轮对话的关键路径上。
   */
  queryVector?: NumericVector | null;
  /** 记忆 id → 已解密的向量；没算过向量的行不出现在这里，也不会在排序里被丢掉。 */
  vectors?: ReadonlyMap<string, NumericVector>;
  /**
   * 情绪行这一类要怎么呈现（任务书 8.3）。缺省 `'implicit'`，也就是库里的默认档，
   * 于是评测 Harness 与任何没传这个字段的调用方拿到的都是今天线上的形状。
   *
   * 它管的只有「带不带、说不说带了几条」：`off` 在排序之前就把情绪行丢掉（所以它也进不了引用清单），
   * `explicit` 在块尾多附一句条数说明。三档都不改写那一行本身，也不给它加任何情绪判词。
   */
  emotionTransparency?: EmotionTransparency;
  /**
   * 情绪总开关（片U）。和上面那档管的是两件事：这一档管「库里的情绪行端不端给模型」，
   * 上面那档管「端过去的要不要特别说明」。两把锁各自独立，任一把关上，情绪行都不出现。
   *
   * 缺席（undefined）按「不关」处理——评测 Harness 和直接调模块的调用方没走引擎，
   * 拿到的该是今天的形状，而不是一路都带着偏好行的那个值。
   */
  emotionEnabled?: boolean;
  /**
   * 这一轮最多选几条（任务书 8.3 的「记忆检索设置」）。缺省 8；
   * 越界值按边界收，不让一个坏值把提示词预算放大。
   */
  limit?: number;
}

/**
 * 保留期过滤 + 召回 + 条数截断——纯函数，不碰数据库。
 *
 * 拆出来是为了认知评测 Harness：它喂 fixture 行走的是这同一个函数，
 * 测到的就是线上那条路径，而不是一份会各自漂移的复刻。
 * 一个相关项都匹配不上时 rankMemories 会退回 recordedAt 倒序，也就是改造前的行为。
 * 向量那一路（5d）只在调用方同时给了 queryVector 和该行的向量时才启用；
 * 线上的 readMemory 两样都不给，所以今天的读侧行为逐字节没变，
 * 等 5e 用真端点量出增益再决定要不要为它付一次出站。
 */
export function selectMemoryCandidates(input: MemorySelectionInput): MemoryDto[] {
  // `off` 和总开关关着都在保留期过滤之前丢：这两档要的都是「连看都不看」，而不是「看了再藏起来」。
  // 排在前面才同时保证两件事——情绪行不进排序，也就拿不到名额、进不了 memoryIds。
  const dropEmotion = input.emotionEnabled === false || input.emotionTransparency === 'off';
  const pool = dropEmotion ? input.rows.filter((memory) => memory.type !== 'emotion') : input.rows;
  // 任务书 8.3 的检索设置：用户可以把每轮注入条数调低。上界仍是 8——
  // 那是提示词预算的一部分，不是「想要更多就更多」。
  const limit = Math.min(MEMORY_READ_MAX_ITEMS, Math.max(1, input.limit ?? MEMORY_READ_MAX_ITEMS));
  const usable = pool.filter((memory) =>
    isMemoryUsable(memory, { policies: input.policies, chatId: input.chatId, now: input.now })
  );
  if (input.queryVector == null) {
    // 衰减排序（Phase 5）默认关：实测它降召回（Recall@8 0.7274→0.7181），按「无实测收益不默认启用」
    // 保持原排序。env COGNITIVE_MEMORY_DECAY=1 才用衰减 tie-break（相关度优先，同分按新近+确认+稳定）。
    if (!memoryDecayEnabled()) return rankMemories(input.query, usable, { limit });
    const scored = scoreByKeyword(input.query, usable);
    scored.sort(
      (left, right) =>
        right.score - left.score || decayPriority(right.memory, input.now) - decayPriority(left.memory, input.now)
    );
    return scored.slice(0, limit).map((entry) => entry.memory);
  }

  // 排序用的是带了 vector 字段的临时对象，返回的必须还是调用方给的那几行：
  // 向量流进渲染和置信度那段，等于把 3072 个浮点数挂在每条记忆上一路带着走。
  const originals = new Map(usable.map((memory) => [memory.id, memory]));
  const candidates = usable.map((memory) => ({ ...memory, vector: input.vectors?.get(memory.id) ?? null }));
  const ranked = rankMemoriesHybrid(input.query, input.queryVector, candidates, { limit });

  return ranked.map((candidate) => originals.get(candidate.id)!);
}

/**
 * 把选中的记忆渲染成一段「数据不是指令」的上下文——纯函数，不碰数据库。
 *
 * 档位由调用方算好传进来：读侧那条路上算分要查证据表，而这里只该管文字。
 * 字符预算是一条硬线，超了就不给，避免长会话把提示词撑爆。
 */
export function renderMemoryBlock(
  memories: readonly MemoryDto[],
  confidence: ReadonlyMap<string, Confidence>,
  emotionTransparency: EmotionTransparency = 'implicit',
  related: readonly RelatedMemoryHit[] = []
): CognitiveBlock[] {
  const lines: string[] = [];
  // 进了 text 的那几条才算引用（任务书 8.2）：报一条模型没读到的记忆，比少报一条更糟。
  const used: string[] = [];
  // 那句条数说明同样只能数真进了文字的：被预算截掉的情绪行，模型根本没看到它。
  let emotionUsed = 0;
  // 说明这一句也要占预算，先给它留位子。留的是「传进来的情绪行条数」这个上界——
  // 进文字的只会等于或少于它，句子只会更短，所以整块的字保证不越 MEMORY_READ_MAX_CHARS。
  const emotionInPool = memories.reduce((count, memory) => (memory.type === 'emotion' ? count + 1 : count), 0);
  const reserve =
    emotionTransparency === 'explicit' && emotionInPool > 0 ? emotionTransparencyNote(emotionInPool).length + 1 : 0;
  let size = MEMORY_TEXT_HEADER.length + reserve;
  for (const memory of memories) {
    const range = describeValidRange(memory);
    const suffix = range === '时间未知' ? '' : `（${range}）`;
    // 算不出档位就按低的处理：宁可多标一句，也不能让一条没凭据的记忆以确定的口气进提示词。
    const marker = (confidence.get(memory.id)?.band ?? 'low') === 'low' ? LOW_CONFIDENCE_MARKER : '';
    const line =
      `- [${TYPE_LABELS[memory.type]}｜${CONTEXT_LABELS[memory.context]}｜${ORIGIN_LABELS[memory.origin]}] ` +
      `${memory.content}${suffix}${marker}`;
    // +1 是行尾换行符：text 是 join('\n') 出来的，预算不算换行，贴边时整块实际会越界。
    if (size + line.length + 1 > MEMORY_READ_MAX_CHARS) break;
    lines.push(line);
    used.push(memory.id);
    if (memory.type === 'emotion') emotionUsed += 1;
    size += line.length + 1;
  }
  if (lines.length === 0) return [];
  // 关联扩展的条目和正文共用同一个字符预算：任务书 3.2 的 1500 是整块上下文，
  // 不是「种子 1500 + 关联 1500」。放不下就一条都不放，并在引用清单里如实缺席。
  const relatedUsed: string[] = [];
  if (related.length > 0) {
    const header = RELATED_BLOCK_HEADER;
    if (size + header.length + 1 <= MEMORY_READ_MAX_CHARS) {
      const relatedLines: string[] = [];
      let relatedSize = size + header.length + 1;
      for (const hit of related) {
        // 关联行同样吃可信度标注：由关系边捞进来的低凭据记忆不得在提示词里光秃秃出现。
        const marker = (confidence.get(hit.memory.id)?.band ?? 'low') === 'low' ? LOW_CONFIDENCE_MARKER : '';
        const line =
          `- [相关｜${RELATION_TYPE_LABELS[hit.relationType]}｜${hit.hop} 跳] ` +
          `${hit.memory.content}（由「${hit.viaSnippet}」关联）${marker}`;
        if (relatedSize + line.length + 1 > MEMORY_READ_MAX_CHARS) break;
        relatedLines.push(line);
        relatedSize += line.length + 1;
        relatedUsed.push(hit.memory.id);
      }
      if (relatedLines.length > 0) lines.push(header, ...relatedLines);
    }
  }
  const note =
    emotionTransparency === 'explicit' && emotionUsed > 0 ? [emotionTransparencyNote(emotionUsed)] : [];
  return [
    {
      module: 'memory',
      label: MEMORY_FRAMING.bracket,
      text: [MEMORY_TEXT_HEADER, ...lines, ...note].join('\n'),
      memoryIds: [...used, ...relatedUsed]
    }
  ];
}

async function writeMemory(turn: CognitiveTurn): Promise<void> {
  // 偏好行读到候选之前，而不是之后：情绪总开关关掉时，抽取层连情绪词表都不比。
  // 代价是「这一轮什么都没抽到」的对话多读一行偏好——那是一次主键查询，
  // 而 8.3 要的是「关闭后不能继续执行对应的数据读取、生成和后台写入」，读它自己的开关不算那条链上的下游。
  const preferences = await getCognitivePreferences(turn.userId);
  let candidates = extractMemoryCandidates(turn.content, { emotionEnabled: preferences.emotionEnabled });
  if (candidates.length === 0) return;

  if (!preferences.memoryEnabled) return;
  // 「暂停长期记忆写入」（任务书 7.3）的闸门开在这三行读之前。
  // 放在 excludedHashes / getMemoryPolicies / listMemories 之后就成了「读了但没写」，
  // 而 8.3 要的是「关闭后不能继续执行对应的数据读取」——除这张偏好行本身之外，零读零写。
  if (preferences.memoryWritePaused) return;

  // AI 二级筛选（Phase 2，env COGNITIVE_AI_MEMORY=1 才开，默认关）：规则已抽出候选才触发，
  // 一轮一次、跑在后台 worker 里。AI 与规则取并集：补充规则漏抓的用户陈述、修正类型，正文仍是
  // 用户亲口说的（origin=explicit 不失真）。模型坏了/解析失败回退规则候选，绝不丢记忆；AI 返回
  // 空数组也不清空规则候选。最终落不落库、要不要先问，仍由下方 write-decision 按用户策略裁决。
  if (aiMemoryExtractionEnabled()) {
    try {
      const provider = await resolveMemoryExtractionProvider(turn.userId);
      const refined = await refineCandidatesWithAI(turn.userId, turn.content, candidates, provider);
      if (refined !== null && refined.length > 0) {
        const merged = [...candidates];
        const indexByKey = new Map(merged.map((candidate, index) => [dedupeKey(candidate.text), index]));
        for (const candidate of refined) {
          const key = dedupeKey(candidate.text);
          const at = indexByKey.get(key);
          if (at === undefined) {
            indexByKey.set(key, merged.length);
            merged.push(candidate);
          } else {
            // 同一条：采纳 AI 修正后的类型，正文保留规则那份用户原话。
            merged[at] = { text: merged[at].text, type: candidate.type };
          }
        }
        candidates = merged.slice(0, MEMORY_CANDIDATES_PER_TURN);
      }
    } catch {
      // provider 解析失败等：回退规则候选，不打断这一轮记忆。
    }
  }

  // 用户永久删除过的内容不许被自动记回来（任务书 7.3）。放在候选检查之后：
  // 这一轮没什么可记的时候，不必为了一张空表多问一次数据库。
  const excluded = await excludedHashes(turn.userId);
  const policies = await getMemoryPolicies(turn.userId);
  // 按 recordedAt 倒序，所以匹配池里的第一条就是最近一次说法。这里不按保留期过滤：过期只是
  // 「不再进对话」，行还在库里，用户改口就该落在那一行上；把过期行剔出匹配池只会让同一件事多存一条。
  // includeSuperseded 同理：用户改口后旧版本被取代，但他哪天原话重说一遍时，旧版本必须还在
  // 匹配池里，known 表才拦得住——否则近重复检测又会跳过完全同句，同一句话落成第二条当前版本。
  const existing = await listMemories(turn.userId, { includeSuperseded: true });
  // 键是归一化后的正文，值记着 id 和来源对话：判断「换个对话又原话说了一遍」得知道旧那条是哪来的。
  const known = new Map(
    existing.map((memory) => [dedupeKey(memory.content), { id: memory.id, chatId: memory.chatId }])
  );
  const superseded = new Set<string>();

  let written = 0;
  // 「先问再记」问出去的句子单独计数：它没进长期库，只是存着等用户哪天去答，不当场打断他，
  // 所以不该吃掉那一轮两条的落库额度。
  let proposed = 0;
  // 这一轮真正落定的行（新建或演化都算），留给循环之后补向量。
  const vectors: Array<{ id: string; text: string }> = [];
  for (const candidate of candidates) {
    if (written >= MEMORY_WRITE_MAX_PER_TURN) break;
    const key = dedupeKey(candidate.text);
    const saidBefore = known.get(key);
    if (saidBefore) {
      // 换个对话又原话说一遍＝一次独立陈述，正是置信度要数的那个东西，此前这里是直接丢掉的。
      // 同一个对话里再说一遍只算强调：记进去等于让一段啰嗦的话把自己抬成高可信。
      if (saidBefore.chatId !== turn.chatId) await recordRestatement(turn, saidBefore.id);
      continue;
    }
    if (excluded.has(exclusionHash(turn.userId, candidate.text))) continue;
    const previousId = findNearDuplicate(candidate, existing);
    // 同一轮里连着两个新说法时，第二个的落点取决于第一个的结果，而我们没有那个结果：
    // 少记一条比留下两条互相冲突的版本便宜。
    if (previousId && superseded.has(previousId)) continue;

    const plan = planMemoryWrite({
      memoryEnabled: preferences.memoryEnabled,
      memoryType: candidate.type,
      text: candidate.text,
      policies,
      supersedeId: previousId
    });

    // 规则抽出来的是用户原话，所以来源是「亲口说」而不是「系统推断」。
    // 时间那一栏交给 temporal：这句话里确实有一个能落地的时间说法，才落 validFrom；
    // 解析不出来就维持 unknown——「不知道说的是什么时候」是合法状态，编一个起点不是。
    const saidAt = turn.occurredAt ?? new Date();
    const frame = resolveTemporalFrame(candidate.text, saidAt, preferences.timezoneOffsetMinutes ?? 0);

    // 「先问再记」问出来的是一句**还没被用户答应**的话，所以它不写记忆行、也不进向量：
    // 它进的是另一张表。这里断了才是错的——那句话会凭空消失，用户的策略空转（片M 修的就是这个）。
    if (plan.decision === 'ASK_CONFIRM') {
      // 超额的「先问再记」逐条跳过就行：break 会连后面本该 WRITE 落库的候选一起丢掉。
      if (proposed >= MEMORY_WRITE_MAX_PER_TURN) continue;
      await proposeCandidate({
        userId: turn.userId,
        chatId: turn.chatId,
        sourceMessageId: turn.sourceMessageId ?? null,
        type: candidate.type,
        context: plan.context,
        content: candidate.text,
        precision: frame?.precision ?? 'unknown',
        validFrom: frame?.validFrom ?? null
      });
      proposed += 1;
      continue;
    }
    if (plan.decision !== 'WRITE' && plan.decision !== 'UPDATE') continue;

    const entry = {
      userId: turn.userId,
      chatId: turn.chatId,
      sourceMessageId: turn.sourceMessageId ?? null,
      type: candidate.type,
      content: candidate.text,
      origin: 'explicit' as MemoryOrigin,
      confirmedAt: saidAt,
      precision: frame?.precision ?? ('unknown' as const),
      validFrom: frame?.validFrom ?? null
    };
    if (plan.decision === 'WRITE') {
      // 记忆行和它的同主题边同生共死：边只是派生，但一条刚落库的记忆在记忆网络里孤立着，
      // 用户看到的就是「系统又没把它和以前的事连起来」。关系写入放在 createMemory 的事务里。
      const created = await createMemory(
        { ...entry, context: plan.context },
        existing.map((memory) => ({ id: memory.id, content: memory.content, context: memory.context }))
      );
      known.set(key, { id: created.id, chatId: turn.chatId });
      vectors.push({ id: created.id, text: candidate.text });
    } else if (previousId) {
      // 演化不带 context：能走到这里说明这句就是旧行那件事的新说法，
      // 主题没变，而只看着这一句短话重新分类只会比旧行记的更弱。
      const revised = await reviseMemory({ ...entry, previousId, reason: SUPERSEDE_REASON });
      superseded.add(previousId);
      known.set(key, { id: revised.id, chatId: turn.chatId });
      vectors.push({ id: revised.id, text: candidate.text });
    } else continue;
    written += 1;
  }

  if (preferences.associationEnabled) await attachVectors(turn.userId, vectors);
}

/**
 * 后台把这一轮新写的记忆逐条算成向量再挂回行上。
 *
 * 放在循环之后而不是循环里：写记忆和算向量是两件事，前者已经落定了，
 * 后者的成败不该改变「这一轮到底记住了什么」。一条算失败就跳过那一条，
 * 其余照常——向量是可选增益，缺它的行仍走关键词召回。
 *
 * 日志只带 id：正文和向量本身都不进日志（任务书要求日志与审计只记 id）。
 */
async function attachVectors(userId: string, targets: readonly { id: string; text: string }[]): Promise<void> {
  for (const target of targets) {
    try {
      const stored = await embedMemoryText(userId, target.id, target.text);
      await attachMemoryVector(userId, target.id, stored);
    } catch {
      log.warn('cognitive.embedding_failed', { userId, memoryId: target.id });
    }
  }
}

/**
 * 记一条「用户又原话说了一遍」的独立证据。
 *
 * 失败只记一条不含正文的告警就放过：证据是附带记录，
 * 写不进去不该把这一轮剩下的候选一起带下水，更不该让用户看到对话报错。
 */
async function recordRestatement(turn: CognitiveTurn, memoryId: string): Promise<void> {
  try {
    await recordEvidenceOutsideTransaction({
      userId: turn.userId,
      memoryId,
      kind: 'supports',
      // 抽出来的是用户原话，所以是「亲口说」，不是系统推断。
      origin: 'explicit',
      sourceMessageId: turn.sourceMessageId ?? null,
      sourceChatId: turn.chatId
    });
  } catch {
    log.warn('cognitive.evidence_failed', { userId: turn.userId, chatId: turn.chatId });
  }
}

export const memoryModule: CognitiveModule = { key: 'memory', read: readMemory, write: writeMemory };

let registered = false;

/** 注册要幂等：对话链路每次构建上下文都会调一遍，不能越注册越多。 */
export function ensureCognitiveModules(): void {
  if (registered) return;
  registered = true;
  registerCognitiveModule(memoryModule);
  registerCognitiveModule(decisionModule);
  registerCognitiveModule(userModelModule);
}
