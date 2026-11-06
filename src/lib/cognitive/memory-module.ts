import {
  registerCognitiveModule,
  type CognitiveBlock,
  type CognitiveModule,
  type CognitiveTurn
} from './manager';
import { extractMemoryCandidates } from './memory-extractor';
import { decisionModule } from './decision-module';
import { userModelModule } from './user-model-module';
import { CONTEXT_LABELS, ORIGIN_LABELS, TYPE_LABELS, describeValidRange } from './memory-display';
import { createMemory, listMemories, reviseMemory, attachMemoryVector } from './memories';
import { embedMemoryText } from './embedding';
import { assessMemories, recordEvidenceOutsideTransaction } from './evidence';
import { excludedHashes, exclusionHash } from './exclusions';
import { log } from '@/lib/logger';
import { getMemoryPolicies } from './policy';
import type { MemoryContext, MemoryPolicy } from './policy';
import type { Confidence } from './confidence';
import { getCognitivePreferences, type EmotionTransparency } from './preferences';
import { rankMemories, rankMemoriesHybrid, type NumericVector } from './retrieval';
import { isMemoryUsable } from './retention';
import { findNearDuplicate, planMemoryWrite } from './write-decision';
import { proposeCandidate } from './memory-candidates';
import { resolveTemporalFrame } from './temporal';
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
 * LINK 和 DELETE 这里没有分支，而且这两个缺口是关掉的：关系全部从库里已有的行派生（2a 判的是不建关系表），
 * 「建立关联」因此永远不会是一次写入动作；删除走的是用户点出来的三种忘记，各有自己的服务与路由。
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

/** 忽略空白和大小写后相同，就认为是同一句话——重复陈述不该变成第二条记忆。 */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

async function readMemory(turn: CognitiveTurn): Promise<CognitiveBlock[]> {
  const now = new Date();
  // 候选池是当前有效的全部记忆（上限 MEMORY_RETRIEVAL_POOL 行），排序交给关键词召回。
  const rows = await listMemories(turn.userId, { asOf: now, take: MEMORY_RETRIEVAL_POOL });
  if (rows.length === 0) return [];

  // 策略表读失败就让这个模块整体失败（manager 会隔离并记一条不含正文的告警）：
  // 读不到保留期就注入，等于把用户设成「30 天」的记忆又端回模型面前，宁可这一轮不带记忆。
  const policies = await getMemoryPolicies(turn.userId);
  const emotionTransparency = turn.emotionTransparency ?? 'implicit';
  const memories = selectMemoryCandidates({
    query: turn.content,
    rows,
    policies,
    chatId: turn.chatId,
    now,
    emotionTransparency
  });
  // 只给要注入的这几条算分：一批一次 groupBy，不是每条各查一次。
  const confidence = await assessMemories(turn.userId, memories, now);
  return renderMemoryBlock(memories, confidence, emotionTransparency);
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
  // `off` 丢在保留期过滤之前：这一档要的是「连看都不看」，而不是「看了再藏起来」。
  // 排在前面才同时保证两件事——情绪行不进排序，也就拿不到名额、进不了 memoryIds。
  const pool =
    input.emotionTransparency === 'off' ? input.rows.filter((memory) => memory.type !== 'emotion') : input.rows;
  const usable = pool.filter((memory) =>
    isMemoryUsable(memory, { policies: input.policies, chatId: input.chatId, now: input.now })
  );
  if (input.queryVector == null) {
    return rankMemories(input.query, usable, { limit: MEMORY_READ_MAX_ITEMS });
  }

  // 排序用的是带了 vector 字段的临时对象，返回的必须还是调用方给的那几行：
  // 向量流进渲染和置信度那段，等于把 3072 个浮点数挂在每条记忆上一路带着走。
  const originals = new Map(usable.map((memory) => [memory.id, memory]));
  const candidates = usable.map((memory) => ({ ...memory, vector: input.vectors?.get(memory.id) ?? null }));
  const ranked = rankMemoriesHybrid(input.query, input.queryVector, candidates, { limit: MEMORY_READ_MAX_ITEMS });

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
  emotionTransparency: EmotionTransparency = 'implicit'
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
    if (size + line.length > MEMORY_READ_MAX_CHARS) break;
    lines.push(line);
    used.push(memory.id);
    if (memory.type === 'emotion') emotionUsed += 1;
    size += line.length;
  }
  if (lines.length === 0) return [];
  const note =
    emotionTransparency === 'explicit' && emotionUsed > 0 ? [emotionTransparencyNote(emotionUsed)] : [];
  return [
    {
      module: 'memory',
      label: MEMORY_FRAMING.bracket,
      text: [MEMORY_TEXT_HEADER, ...lines, ...note].join('\n'),
      memoryIds: used
    }
  ];
}

async function writeMemory(turn: CognitiveTurn): Promise<void> {
  const candidates = extractMemoryCandidates(turn.content);
  if (candidates.length === 0) return;

  const preferences = await getCognitivePreferences(turn.userId);
  if (!preferences.memoryEnabled) return;
  // 「暂停长期记忆写入」（任务书 7.3）的闸门开在这三行读之前。
  // 放在 excludedHashes / getMemoryPolicies / listMemories 之后就成了「读了但没写」，
  // 而 8.3 要的是「关闭后不能继续执行对应的数据读取」——除这张偏好行本身之外，零读零写。
  if (preferences.memoryWritePaused) return;

  // 用户永久删除过的内容不许被自动记回来（任务书 7.3）。放在候选检查之后：
  // 这一轮没什么可记的时候，不必为了一张空表多问一次数据库。
  const excluded = await excludedHashes(turn.userId);
  const policies = await getMemoryPolicies(turn.userId);
  // listMemories 只给当前有效版本、按 recordedAt 倒序，所以匹配池里的第一条就是最近一次说法。
  // 这里不按保留期过滤：过期只是「不再进对话」，行还在库里，用户改口就该落在那一行上；
  // 把过期行剔出匹配池只会让同一件事多存一条。
  const existing = await listMemories(turn.userId);
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
    const frame = resolveTemporalFrame(candidate.text, saidAt);

    // 「先问再记」问出来的是一句**还没被用户答应**的话，所以它不写记忆行、也不进向量：
    // 它进的是另一张表。这里断了才是错的——那句话会凭空消失，用户的策略空转（片M 修的就是这个）。
    if (plan.decision === 'ASK_CONFIRM') {
      if (proposed >= MEMORY_WRITE_MAX_PER_TURN) break;
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
      const created = await createMemory({ ...entry, context: plan.context });
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
