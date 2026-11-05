import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as list } from '@/app/api/account/cognitive/candidates/route';
import { PATCH as decide } from '@/app/api/account/cognitive/candidates/[id]/route';

/**
 * 待确认候选接口（任务书 1.2 的 ASK_CONFIRM，片M 的后端那一半）。
 *
 * 这一屏的形状和别的认知屏**相反**，所以最容易被顺手改错，这里把它钉死：
 *
 * 一、**读和拒都不吃 `memoryEnabled`。** 这一屏是隐私控件，不是模块视图：用户关掉长期记忆之后，
 * 门口还站着一排没答过的问题，看不见也答不了，就等于「关掉之后系统继续替你留着你的原话」。
 * 口径来自片L 对记忆那一屏的裁决（`cognitive-memories-route.test.ts` 末尾那一节）。
 *
 * 二、**确认吃闸门。** 点「记住」是真的往长期库里写一行，那是模块在运行，
 * 所以 `memoryEnabled` 关着、或「暂停长期记忆写入」开着时，这一步必须是 409，
 * 而不是先解密、抢占、写行再报错。
 *
 * 三、审计里只有 id 和情境枚举，一个字的正文都没有（任务书 5.5）。候选正文是用户原话，
 * 确认之后它就长期躺在 MemoryItem 的密文列里；审计是一份明文日志，跟着它走就等于绕过了加密。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  memoryEnabled: true,
  memoryWritePaused: false,
  preferencesThrows: false,
  rateLimited: false,
  listCalls: [] as Array<{ userId: string; status?: string; take?: number }>,
  candidates: [] as Array<Record<string, unknown>>,
  confirmCalls: [] as Array<{ userId: string; id: string }>,
  rejectCalls: [] as Array<{ userId: string; id: string }>,
  confirmThrows: null as { status: number; code: string; message: string } | null,
  learnerCalls: [] as Array<{ userId: string; contexts: string[] }>,
  learned: [] as string[],
  auditCalls: [] as Array<Record<string, unknown>>
}));

vi.mock('@/lib/auth', async () => {
  const { ApiError } = await import('@/lib/http');
  return {
    requireUser: () =>
      db.authThrows
        ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
        : Promise.resolve({ user: { id: 'user-a', username: 'konxing' }, session: { id: 'sess-1' } })
  };
});

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () => {
    if (db.preferencesThrows) return Promise.reject(new Error('数据库连接中断'));
    return Promise.resolve({ memoryEnabled: db.memoryEnabled, memoryWritePaused: db.memoryWritePaused });
  }
}));

vi.mock('@/lib/cognitive/memory-candidates', async () => {
  const { ApiError } = await import('@/lib/http');
  return {
    listCandidates: (userId: string, filters: { status?: string; take?: number }) => {
      db.listCalls.push({ userId, status: filters.status, take: filters.take });
      return Promise.resolve(db.candidates);
    },
    confirmCandidate: (id: string, userId: string) => {
      db.confirmCalls.push({ userId, id });
      if (db.confirmThrows) {
        return Promise.reject(new ApiError(db.confirmThrows.status, db.confirmThrows.code, db.confirmThrows.message));
      }
      return Promise.resolve({ id: 'mem-1', type: 'decision', context: 'decisionMaking', content: '我决定辞职' });
    },
    rejectCandidate: (id: string, userId: string) => {
      db.rejectCalls.push({ userId, id });
      return Promise.resolve('decisionMaking');
    }
  };
});

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => (db.rateLimited ? { ok: false, retryAfterSec: 120 } : { ok: true })
}));

vi.mock('@/lib/cognitive/policy-learner', () => ({
  learnAfterSignals: (userId: string, contexts: string[]) => {
    db.learnerCalls.push({ userId, contexts });
    return Promise.resolve(db.learned);
  }
}));

vi.mock('@/lib/audit', () => ({
  writeAudit: (input: Record<string, unknown>) => {
    db.auditCalls.push(input);
    return Promise.resolve();
  }
}));

function getList(url = 'http://x/api/account/cognitive/candidates') {
  return list(new Request(url));
}

function patch(body: unknown, id = 'cand-1') {
  return decide(
    new Request(`http://x/api/account/cognitive/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe('待确认候选接口', () => {
  beforeEach(() => {
    db.authThrows = false;
    db.memoryEnabled = true;
    db.memoryWritePaused = false;
    db.preferencesThrows = false;
    db.rateLimited = false;
    db.listCalls = [];
    db.candidates = [];
    db.confirmCalls = [];
    db.rejectCalls = [];
    db.confirmThrows = null;
    db.learnerCalls = [];
    db.learned = [];
    db.auditCalls = [];
  });

  it('未登录是 401', async () => {
    db.authThrows = true;
    expect((await getList()).status).toBe(401);
    expect((await patch({ action: 'confirm' })).status).toBe(401);
  });

  it('列表默认只看待确认的，身份只来自 session', async () => {
    db.candidates = [{ id: 'cand-1', status: 'pending', content: '我决定辞职' }];
    const res = await getList();
    expect(res.status).toBe(200);
    expect(db.listCalls).toHaveLength(1);
    expect(db.listCalls[0]!.userId).toBe('user-a');
    expect(db.listCalls[0]!.status).toBeUndefined();
    const body = await res.json();
    expect(body.data.candidates).toHaveLength(1);
  });

  it('status 可以换成一档已答过的，界面才答得上「为什么这句不再问了」', async () => {
    await getList('http://x/api/account/cognitive/candidates?status=rejected');
    expect(db.listCalls[0]!.status).toBe('rejected');
  });

  it('status 不在枚举里是 400，且不查库', async () => {
    const res = await getList('http://x/api/account/cognitive/candidates?status=all');
    expect(res.status).toBe(400);
    expect(db.listCalls).toHaveLength(0);
  });

  it('顶到列表上限时 capped 报出来，不让用户把截断当成「没有更多了」', async () => {
    db.candidates = Array.from({ length: 200 }, (_, index) => ({ id: `cand-${index}` }));
    const res = await getList();
    const body = await res.json();
    expect(body.data.capped).toBe(true);
  });

  /**
   * 片L 裁决的同一件事，这一屏更极端：列表里的东西**全是没被用户答应过的原话**。
   * 关掉长期记忆后把它们藏起来，等于让这批明文继续存在却再也碰不到。
   */
  it('长期记忆关着：这一屏照样可达，一次服务层调用都不少', async () => {
    db.memoryEnabled = false;
    db.candidates = [{ id: 'cand-1', status: 'pending' }];

    const res = await getList();

    expect(res.status).toBe(200);
    expect(db.listCalls).toHaveLength(1);
  });

  it('确认：盖状态、写记忆，回创建出来的那一行', async () => {
    const res = await patch({ action: 'confirm' });
    expect(res.status).toBe(200);
    expect(db.confirmCalls).toEqual([{ userId: 'user-a', id: 'cand-1' }]);
    const body = await res.json();
    expect(body.data.memory).toMatchObject({ id: 'mem-1', context: 'decisionMaking' });
  });

  it('拒绝：这一句永远不进记忆', async () => {
    const res = await patch({ action: 'reject' });
    expect(res.status).toBe(200);
    expect(db.rejectCalls).toEqual([{ userId: 'user-a', id: 'cand-1' }]);
    expect(db.confirmCalls).toHaveLength(0);
  });

  /**
   * 「不要记」和「永久删掉」说的是同一件事（任务书 1.3），所以它得喂同一个学习层。
   * 学习跑在服务层事务提交之后：证据行得先落库才数得到；而且这一步失败不许把
   * 「用户已经答过不」回滚掉——那是用户要的结果。
   */
  it('拒绝之后跑一次学习，被收紧的情境回给界面', async () => {
    db.learned = ['decisionMaking'];

    const res = await patch({ action: 'reject' });
    const body = await res.json();

    expect(db.learnerCalls).toEqual([{ userId: 'user-a', contexts: ['decisionMaking'] }]);
    expect(body.data).toMatchObject({ rejected: true, context: 'decisionMaking', learned: ['decisionMaking'] });
  });

  /** 确认是「要记」，不是证据：喂给学习层等于让用户点一次记住就收紧一次。 */
  it('确认不跑学习', async () => {
    await patch({ action: 'confirm' });

    expect(db.learnerCalls).toHaveLength(0);
  });

  it('长期记忆关着时的拒绝照样喂学习层：那是另一个开关，闸门由学习层自己问', async () => {
    db.memoryEnabled = false;

    await patch({ action: 'reject' });

    expect(db.learnerCalls).toHaveLength(1);
  });

  /** 审计是明文日志：候选正文是用户原话，跟着动作进审计就等于绕过整站加密（任务书 5.5）。 */
  it('两条动作各留一条审计，里面只有 id 和情境枚举', async () => {
    await patch({ action: 'confirm' });
    await patch({ action: 'reject' });

    expect(db.auditCalls).toHaveLength(2);
    expect(db.auditCalls[0]).toMatchObject({
      actorId: 'user-a',
      action: 'user.memory_candidate_confirm',
      targetType: 'memoryCandidate',
      targetId: 'cand-1',
      after: { memoryId: 'mem-1', context: 'decisionMaking' }
    });
    expect(db.auditCalls[1]).toMatchObject({
      action: 'user.memory_candidate_reject',
      targetId: 'cand-1',
      after: { context: 'decisionMaking', learned: [] }
    });
    const dumped = JSON.stringify(db.auditCalls);
    expect(dumped.includes('我决定辞职')).toBe(false);
  });

  it('长期记忆关着：拒绝照常允许，确认才是 409', async () => {
    db.memoryEnabled = false;

    expect((await patch({ action: 'reject' })).status).toBe(200);
    expect((await patch({ action: 'confirm' })).status).toBe(409);
    expect(db.confirmCalls).toHaveLength(0);
    expect(db.rejectCalls).toHaveLength(1);
  });

  it('暂停长期记忆写入时确认也是 409：暂停的就是「还记不记新东西」', async () => {
    db.memoryWritePaused = true;

    const res = await patch({ action: 'confirm' });
    expect(res.status).toBe(409);
    expect(db.confirmCalls).toHaveLength(0);
  });

  it('偏好读不出来按关闭处理：确认 409，一次服务层调用都不发', async () => {
    db.preferencesThrows = true;

    expect((await patch({ action: 'confirm' })).status).toBe(409);
    expect(db.confirmCalls).toHaveLength(0);
  });

  it('闸门拦住的确认给一句人话，不说成服务端故障', async () => {
    db.memoryEnabled = false;
    const body = await (await patch({ action: 'confirm' })).json();
    expect(body.error.code).toBe('MODULE_DISABLED');
    expect(body.error.message).toBe('长期记忆没有打开；打开后才能把这句话记成长期记忆');
  });

  it('动词不在白名单里是 400，且不动服务层', async () => {
    expect((await patch({ action: 'maybe' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(db.confirmCalls).toHaveLength(0);
    expect(db.rejectCalls).toHaveLength(0);
  });

  it('限流命中是 429，两条动作都不动服务层', async () => {
    db.rateLimited = true;
    expect((await patch({ action: 'confirm' })).status).toBe(429);
    expect((await patch({ action: 'reject' })).status).toBe(429);
    expect(db.confirmCalls).toHaveLength(0);
    expect(db.rejectCalls).toHaveLength(0);
  });

  /** 双击、两个人、或者「已经过期被淘汰」都落在服务层那一句 409 上，路由原样传回。 */
  it('服务层说这句已经答过了：409 原样传回，不补写审计', async () => {
    db.confirmThrows = { status: 409, code: 'CANDIDATE_DECIDED', message: '这条候选已经处理过了' };

    const res = await patch({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(db.auditCalls).toHaveLength(0);
  });
});
