import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/account/cognitive/failed-tasks/route';

/**
 * 「没记上的句子」接口（任务书 §6 要求④「支持失败任务查看」的后端）。
 *
 * 这一屏读的是 CognitiveTask 表里的**调度列**：状态、次数、错误码、时间。没有一处解密，
 * 所以这里要钉的五件事和别的认知屏不一样：
 *
 * 一、身份只来自 session，`userId` 是服务层筛选条件的全部来源；
 * 二、**八个开关全关时照样返回 200，而且一次偏好都不读。** 这是 片L-1 那条裁决的延伸：
 *    关掉模块不该顺手取消「看见这个模块为你漏了什么」的权利，而这里连一行记忆正文都不读，
 *    补闸门只会把「失败任务查看」变成「失败任务对自己不可见」。
 *    它的牙齿由本文件倒数第二节量过（在路由里临时插一次 409，两条用例立刻红，按字面回滚）。
 * 三、响应里的键集恒为那五个，多一个都不行——出现 `content` / `text` 这类键就说明有人在往这屏
 *    塞解密结果，出现 `sourceMessageId` 就说明有人给了一点对不动的坐标（会话页没有滚到某一句的锚点）；
 * 四、`capped` 由服务层给，路由不重算：界面那句「比这一屏多」要说的是服务端实际读了几行；
 * 五、没有查询参数。多一个入口就多一条通向别人账号的路，而这一屏只有「我名下判死的行」一种范围。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  preferencesCalls: [] as string[],
  listCalls: [] as string[],
  tasks: [] as Array<Record<string, unknown>>,
  capped: false
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
  getCognitivePreferences: (userId: string) => {
    db.preferencesCalls.push(userId);
    return Promise.resolve(
      Object.fromEntries(
        [
          'memoryEnabled',
          'emotionEnabled',
          'reflectionEnabled',
          'timelineEnabled',
          'decisionEnabled',
          'profileEnabled',
          'retrievalEnabled',
          'responsePolicyEnabled'
        ].map((key) => [key, false])
      )
    );
  }
}));

vi.mock('@/lib/cognitive/failed-tasks', () => ({
  FAILED_TASK_LIST_MAX_ROWS: 50,
  listFailedCognitiveTasks: (userId: string) => {
    db.listCalls.push(userId);
    return Promise.resolve({ tasks: db.tasks, capped: db.capped });
  }
}));

function get(url = 'http://x/api/account/cognitive/failed-tasks') {
  return GET(new Request(url));
}

function deadTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    chatId: 'chat-1',
    failedAt: '2026-11-05T08:02:00.000Z',
    attempts: 3,
    reason: 'retry_exhausted',
    ...overrides
  };
}

describe('失败任务接口', () => {
  beforeEach(() => {
    db.authThrows = false;
    db.preferencesCalls = [];
    db.listCalls = [];
    db.tasks = [];
    db.capped = false;
  });

  it('未登录是 401，一次服务层调用都不发', async () => {
    db.authThrows = true;

    const res = await get();

    expect(res.status).toBe(401);
    expect(db.listCalls).toHaveLength(0);
  });

  it('只把 session 里的 userId 交给服务层', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(db.listCalls).toEqual(['user-a']);
  });

  it('返回就是服务层那一份：tasks 原样、capped 不重算', async () => {
    db.tasks = [deadTask()];
    db.capped = true;

    const body = await (await get()).json();

    expect(body.data).toEqual({ tasks: [deadTask()], capped: true });
  });

  it('没有任何判死的行时是空列表，不是 404 也不是错误', async () => {
    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ tasks: [], capped: false });
  });

  /**
   * 这屏的每一行只准带那五个键。写宽一个键，就等于有人开始把解密后的正文往「调度」这一屏端。
   */
  it('每行的键集恒为那五个：没有正文、没有会话标题', async () => {
    db.tasks = [deadTask(), deadTask({ id: 'task-2', reason: 'timeout' })];

    const body = await (await get()).json();

    expect(body.data.tasks.map((row: Record<string, unknown>) => Object.keys(row).sort())).toEqual([
      ['attempts', 'chatId', 'failedAt', 'id', 'reason'],
      ['attempts', 'chatId', 'failedAt', 'id', 'reason']
    ]);
  });

  it('带查询参数也不改变范围：这一屏只有「我名下」一种口径', async () => {
    db.tasks = [deadTask()];

    const res = await get('http://x/api/account/cognitive/failed-tasks?userId=user-b&chatId=chat-9');

    expect(res.status).toBe(200);
    expect(db.listCalls).toEqual(['user-a']);
  });

  /**
   * 片L-1 的裁决在「管理自己已存下的行」这一类读取上一致成立：
   * 全关时这一屏照样可达，而且**根本不去读偏好**——不读比「读了但不拦」更省，也更不可能改口。
   */
  it('八个开关全关：照样 200，一次偏好都不读', async () => {
    db.tasks = [deadTask()];

    const res = await get();

    expect(res.status).toBe(200);
    expect(db.preferencesCalls).toHaveLength(0);
    expect(db.listCalls).toEqual(['user-a']);
  });

  it('这一屏只有 GET：POST/DELETE 这些动词没有入口', async () => {
    const mod = await import('@/app/api/account/cognitive/failed-tasks/route');

    expect(Object.keys(mod).sort()).toEqual(['GET', 'runtime']);
    expect(mod.runtime).toBe('nodejs');
  });
});
