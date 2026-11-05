import { api, getRequestIp, getUserAgent, jsonError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { memoryPurgeSchema } from '@/lib/validation';
import { listMemories, MEMORY_LIST_MAX_ROWS } from '@/lib/cognitive/memories';
import { assessMemories, listEvidenceRows } from '@/lib/cognitive/evidence';
import { reviewMemories } from '@/lib/cognitive/reconsolidation';
import { listAccessStats, type AccessStats, type MemoryAccessStat } from '@/lib/cognitive/access';
import { purgeAllMemories, purgeMemoriesByChat, purgeMemoriesByContext } from '@/lib/cognitive/forgetting';
import { learnAfterSignals } from '@/lib/cognitive/policy-learner';
import { listChatTitles } from '@/lib/chats';
import type { Confidence } from '@/lib/cognitive/confidence';

export const runtime = 'nodejs';

/**
 * 清空全部一小时 3 次、按会话和按主题各一小时 20 次：前者是一次不可逆的大动作，
 * 后两者是用户逐个清理，得给足余地。三个桶各算各的额度，免得清空用掉的额度挡住正常清理，
 * 也免得「把这一个主题挨个清一遍」顺带把「按会话清」的那一路堵死。
 */
const PURGE_ALL_LIMIT = 3;
const PURGE_CHAT_LIMIT = 20;
const PURGE_CONTEXT_LIMIT = 20;
const PURGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 我的记忆列表（任务书 8.2「记忆管理」）。正文是服务层解了密才回来的，收件人只有 session 里这一个用户。
 *
 * 这里不接任何过滤或翻页参数：多一个入口，就多一条通向别人账号的路，
 * 而当前有效的那几十条本来就一次读得完。
 *
 * 已归档的那一份（任务书 7.2）跟着同一份响应回来：归档得有地方恢复，
 * 否则这个动作就是一扇进得去出不来的门。
 *
 * chats 和 confidence 都是旁表，不塞进每条记忆里：MemoryDto 是服务层的形状，
 * 不该为了一个界面在这里编字段；而且同一个会话标题会被多条记忆共用。
 *
 * confidence 只给档位和因子，不给分数——一个三位小数会被当成精确真理，
 * 而它只是一条确定性规则的产物。因子是给界面翻译成中文用的，也是「凭什么信这条」的说明书。
 *
 * `capped` / `archivedCapped` 是两份列表各自的 200 行上限标志（口径和时间线、洞察那屏一样）：
 * 服务层读多少行界面就列多少行，到顶的那一批不报出来的话，「这里没有更早的」就会被读成
 * 「更早的没发生过」。两个标志分开算，是因为少掉的那批分属两个桶，混成一个数就说不清少了什么。
 *
 * `reviews` / `access` 是任务书 7.1 那一屏的两份旁表。它们都不进置信度：
 * 置信度只由 evidence.ts + confidence.ts 那一份算出来，而这里的标记只回答「这条值得回看一眼」，
 * 访问次数只是「这一轮把它带进过提示词」的事实计数。两条红线（检索次数不提可信度、
 * 访问频率不替代证据）由 tests/unit/cognitive-access.test.ts 的逐字节相等用例守着。
 *
 * 这一屏（含 `[id]` 下的改口 / 撤回 / 归档 / 恢复 / 证据五条路）**故意不吃 `memoryEnabled`**，
 * 别把它当成漏掉的闸门补上。任务书 1.1 的「所有模块开关必须在服务端执行」管的是认知引擎自己：
 * 注入提示词、派生视图（时间线 / 变化 / 网络 / 洞察 / 画像）、后台任务——那五处都实打实查过开关。
 * 而这里没有模块在运行，只有用户在自己账号里看和删已经存下的行。
 * 给它补闸门的后果是「关掉长期记忆 = 看不见也删不掉已有记忆」，
 * 那正是 7.2 归档那一节反对的「进得去出不来的门」，也和任务书第七节
 * 「用户始终拥有查看、修改、暂停和删除权」相冲。
 * 反向的门不会因此关不上：真正的写侧闸门在 `memory-module.ts`，开关关着就不再产生新行。
 * 这条裁决由 tests/unit/cognitive-memories-route.test.ts 末尾那一节钉住（八个开关全 false 时七条路照样通），
 * 它的牙齿由片L 的两支变异探针量过（在 GET 和 DELETE 各插一次 403，用例立刻红，按字面回滚）。
 *
 * `accessWindow` 取的是**实际扫过的轮数**，不把 `MEMORY_ACCESS_MAX_ROWS` 抄给界面：
 * 抄的那一份会先过期。归档那一份不参与再巩固检查——被收起的行已经不是当前说法了，
 * 给它挂「有新的支持信息」只会把注意力引向一排不该再进提示词的行。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    // 那一屏不喂 chats，也不参与置信度：它只要求「看清收起来的是什么，然后恢复」，
    // 多算一份只是给一次点开付两批解密的钱。两份互不依赖，所以并发读，不串行等两轮往返。
    const [memories, archived] = await Promise.all([
      listMemories(user.id),
      listMemories(user.id, { archivedOnly: true })
    ]);
    const [chats, confidence, evidenceRows, access] = await Promise.all([
      listChatTitles(
        user.id,
        memories.map((memory) => memory.chatId)
      ),
      memories.length === 0
        ? Promise.resolve(new Map<string, Confidence>())
        : assessMemories(user.id, memories),
      listEvidenceRows(user.id, memories.map((memory) => memory.id)),
      memories.length === 0
        ? Promise.resolve<AccessStats>({ byMemory: new Map<string, MemoryAccessStat>(), scannedTurns: 0, capped: false })
        : listAccessStats(user.id)
    ]);
    const byMemory = new Map<string, typeof evidenceRows>();
    for (const row of evidenceRows) {
      const list = byMemory.get(row.memoryId);
      if (list) list.push(row);
      else byMemory.set(row.memoryId, [row]);
    }
    const reviews = reviewMemories(
      // MemoryDto 没有 archivedAt 这一列：listMemories 的默认桶本来就排除了归档行，
      // 所以这里恒为 null 不是「假设没归档」，是这一批的定义。
      memories.map((memory) => ({
        id: memory.id,
        origin: memory.origin,
        recordedAt: memory.recordedAt,
        validTo: memory.validTo,
        supersededAt: memory.supersededAt,
        archivedAt: null
      })),
      byMemory
    );
    return {
      memories,
      archived,
      capped: memories.length >= MEMORY_LIST_MAX_ROWS,
      archivedCapped: archived.length >= MEMORY_LIST_MAX_ROWS,
      chats,
      confidence: Object.fromEntries(
        [...confidence].map(([id, entry]) => [id, { band: entry.band, factors: entry.factors }])
      ),
      reviews: Object.fromEntries(reviews),
      access: Object.fromEntries([...access.byMemory].map(([id, stat]) => [id, stat.count])),
      accessWindow: access.scannedTurns,
      accessCapped: access.capped
    };
  });
}

/**
 * 批量永久删除（任务书 7.3 的三臂：「忘记某个主题」「忘记某个来源会话产生的记忆」「清空全部长期记忆」）。
 *
 * 范围只从查询串读，userId 只从 session 取：chatId 是任意字符串输入，
 * 但服务层的删除条件里始终带着 session 的 userId，塞别人的会话 id 只会删掉 0 行。
 * 三种范围都只删记忆，不动会话、附件和消息。
 */
export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const params = new URL(req.url).searchParams;
    const scope = memoryPurgeSchema.parse({
      scope: params.get('scope'),
      chatId: params.get('chatId'),
      context: params.get('context')
    });

    if (scope.scope === 'all') {
      const limit = rateLimit(`memory-purge-all:${user.id}`, PURGE_ALL_LIMIT, PURGE_WINDOW_MS);
      if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
      const result = await purgeAllMemories(user.id);
      // 清空全部不产生学习证据，所以这里永远是空数组：一次重置不该被读成「七个情境都记太多了」。
      const learned = await learnAfterSignals(user.id, result.contexts);
      await audit(req, user, 'user.memory_purge_all', 'user', user.id, result.purged, learned);
      return { purged: result.purged, learned };
    }

    if (scope.scope === 'context') {
      const limit = rateLimit(`memory-purge-context:${user.id}`, PURGE_CONTEXT_LIMIT, PURGE_WINDOW_MS);
      if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
      const result = await purgeMemoriesByContext(scope.context, user.id);
      const learned = await learnAfterSignals(user.id, result.contexts);
      await audit(req, user, 'user.memory_purge_by_context', 'context', scope.context, result.purged, learned);
      return { purged: result.purged, learned };
    }

    const limit = rateLimit(`memory-purge-chat:${user.id}`, PURGE_CHAT_LIMIT, PURGE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const result = await purgeMemoriesByChat(scope.chatId, user.id);
    const learned = await learnAfterSignals(user.id, result.contexts);
    await audit(req, user, 'user.memory_purge_by_chat', 'chat', scope.chatId, result.purged, learned);
    return { purged: result.purged, learned };
  });
}

/** 删除是不可逆动作，必须留痕；但审计里只有范围、目标 id、条数和情境枚举，没有正文（任务书 5.5）。 */
async function audit(
  req: Request,
  user: { id: string; username: string },
  action: string,
  targetType: string,
  targetId: string,
  purged: number,
  learned: readonly string[]
): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorLabel: user.username,
    action,
    targetType,
    targetId,
    after: { purged, learned },
    ip: getRequestIp(req),
    userAgent: getUserAgent(req)
  });
}
