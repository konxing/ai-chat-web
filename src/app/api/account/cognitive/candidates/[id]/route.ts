import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { getCognitivePreferences } from '@/lib/cognitive/preferences';
import { memoryCandidateActionSchema } from '@/lib/validation';
import { confirmCandidate, rejectCandidate } from '@/lib/cognitive/memory-candidates';
import { learnAfterSignals } from '@/lib/cognitive/policy-learner';

export const runtime = 'nodejs';

/**
 * 一小时 60 次，确认和拒绝共用一个桶。
 *
 * 比改口（30 次）宽，是因为这一屏的正常用法是「一排问题挨个答完」：待确认上限 200 条，
 * 30 次/小时会让人清到一半被卡住，而卡住的代价是那些句子继续留在门口没人回答。
 * 两个动作共用一个桶也不亏——它们消耗的是同一样东西：用户当场读一句话、当场拿个主意的注意力。
 */
const DECIDE_LIMIT = 60;
const DECIDE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 回答一条待确认候选：`confirm` 让这句话成为记忆，`reject` 让它永远不进记忆。
 *
 * 只有两个动作，没有第三个按钮——理由在服务层那份 schema 的注释里（不给「先搁着」的档位，
 * 这屏就会长成一个谁都不当场回答的收件箱）。
 *
 * 闸门只管 `confirm`：那一步真的往长期库写一行，属于「模块在运行」，所以长期记忆关着、
 * 或「暂停长期记忆写入」开着时它必须是 409，而且要在读候选行、解密正文之前停下。
 * `reject` 不设闸门：它删的是访问路径都不给的一行，是清理不是写入——
 * 关掉长期记忆的用户恰恰最希望把自己说过的话清出去，这里挡他等于替他做决定。
 *
 * 学习证据只有拒绝这一头：「不要记」和「永久删掉」是同一句话（任务书 1.3），共用同一个学习层。
 * 确认不喂——那是用户说「要记」，把它算进证据就变成多点几次记住就把情境收紧，方向反了。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-candidate-decide:${user.id}`, DECIDE_LIMIT, DECIDE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const action = memoryCandidateActionSchema.parse(await readJson(req));
    const { id } = await ctx.params;

    if (action.action === 'confirm') {
      const gates = await writeGates(user.id);
      if (!gates.memoryEnabled) {
        throw new ApiError(409, 'MODULE_DISABLED', '长期记忆没有打开；打开后才能把这句话记成长期记忆');
      }
      if (gates.writePaused) {
        throw new ApiError(409, 'MODULE_DISABLED', '长期记忆写入暂停中；恢复写入后才能把这句话记成长期记忆');
      }
      const memory = await confirmCandidate(id, user.id);
      await audit(req, user, 'user.memory_candidate_confirm', id, {
        memoryId: memory.id,
        context: memory.context
      });
      return { memory };
    }

    const context = await rejectCandidate(id, user.id);
    // 学习跑在服务层事务提交之后：证据行得先落库才数得到，且这一步失败不许把
    // 「用户已经答过不」回滚掉。口径和三条忘记链路一致，闸门在学习层自己那儿问。
    const learned = await learnAfterSignals(user.id, [context]);
    await audit(req, user, 'user.memory_candidate_reject', id, { context, learned });
    return { rejected: true, context, learned };
  });
}

/**
 * 确认这一步的两道闸门，读不出来按「都没开」处理——和 manager.ts、时间线同一个口径：
 * 认知引擎拿不准的时候宁可什么都不写。这一行少了两次数据库往返，换的是「不会在用户没表达过的
 * 情况下替他记一句话」。
 */
async function writeGates(userId: string): Promise<{ memoryEnabled: boolean; writePaused: boolean }> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return {
      memoryEnabled: preferences.memoryEnabled === true,
      writePaused: preferences.memoryWritePaused === true
    };
  } catch {
    return { memoryEnabled: false, writePaused: true };
  }
}

/**
 * 审计里只有动作、那一行的 id 和情境枚举，一个字的正文都没有（任务书 5.5）。
 *
 * 这不是随手收口：候选正文是用户的原话，确认之后它长期存在密文列里，而审计表是明文。
 * 把正文抄进审计，等于给整站加密开了一个「日志里查原文」的后门。
 */
async function audit(
  req: Request,
  user: { id: string; username: string },
  action: string,
  targetId: string,
  after: Record<string, unknown>
): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorLabel: user.username,
    action,
    targetType: 'memoryCandidate',
    targetId,
    after,
    ip: getRequestIp(req),
    userAgent: getUserAgent(req)
  });
}
