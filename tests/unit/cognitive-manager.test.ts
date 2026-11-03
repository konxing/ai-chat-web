import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 认知引擎挂在主聊天链路上，任何模块出错都不能把对话一起拖死（原则 9）；
 * 出错时上报的内容也不能带用户正文——logger 没有脱敏机制，全靠调用方只记 id（原则 14）。
 * 注册表是模块级状态，每个用例用 vi.resetModules() 拿一份干净的。
 */
const db = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  throws: false,
  warns: [] as Array<[string, Record<string, unknown>]>
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cognitivePreference: {
      findUnique: () => {
        if (db.throws) return Promise.reject(new Error('数据库连接断了'));
        return Promise.resolve(Object.keys(db.row).length ? db.row : null);
      }
    }
  }
}));

vi.mock('@/lib/logger', () => ({
  log: {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown>) => {
      db.warns.push([event, fields]);
    },
    error: () => undefined
  }
}));

async function loadManager() {
  vi.resetModules();
  return await import('@/lib/cognitive/manager');
}

function turnFixture(overrides: Record<string, unknown> = {}) {
  return { userId: 'user-a', chatId: 'chat-1', content: '我今天不太想聊工作', ...overrides };
}

beforeEach(() => {
  db.row = {};
  db.throws = false;
  db.warns = [];
});

describe('认知模块的读侧', () => {
  it('开关没打开的模块根本不会被调用', async () => {
    const manager = await loadManager();
    let calls = 0;
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => {
        calls += 1;
        return Promise.resolve([]);
      }
    });

    const result = await manager.runCognitiveReads(turnFixture());

    expect(calls).toBe(0);
    expect(result.blocks).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('打开记忆模块后，它产出的片段被带回来', async () => {
    const manager = await loadManager();
    db.row = { memoryEnabled: true };
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => Promise.resolve([{ module: 'memory', label: '相关记忆', text: '用户的孩子叫小满' }])
    });

    const result = await manager.runCognitiveReads(turnFixture());

    expect(result.blocks).toEqual([{ module: 'memory', label: '相关记忆', text: '用户的孩子叫小满' }]);
    expect(result.failed).toEqual([]);
  });

  it('一个模块抛错，另一个照常产出，且错误原文不进返回值也不进日志', async () => {
    const manager = await loadManager();
    db.row = { memoryEnabled: true, userModelEnabled: true };
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => Promise.reject(new Error('解析失败，原文：用户的孩子叫小满'))
    });
    manager.registerCognitiveModule({
      key: 'userModel',
      read: () => Promise.resolve([{ module: 'userModel', label: '用户画像', text: '偏好简短回答' }])
    });

    const result = await manager.runCognitiveReads(turnFixture());

    expect(result.failed).toEqual(['memory']);
    expect(result.blocks.map((block) => block.module)).toEqual(['userModel']);
    const serialized = JSON.stringify({ result, warns: db.warns });
    expect(serialized).not.toContain('小满');
    expect(serialized).not.toContain('解析失败');
    expect(db.warns.map((entry) => entry[0])).toContain('cognitive.read_failed');
  });

  it('七个模块各看各的开关，互不牵连', async () => {
    const manager = await loadManager();
    const keys = ['memory', 'userModel', 'emotion', 'association', 'timeline', 'reflection', 'decisionMemory'] as const;
    const called: string[] = [];
    for (const key of keys) {
      manager.registerCognitiveModule({
        key,
        read: () => {
          called.push(key);
          return Promise.resolve([{ module: key, label: key, text: '片段' }]);
        }
      });
    }

    for (const key of keys) {
      called.length = 0;
      db.row = { [`${key}Enabled`]: true };
      const result = await manager.runCognitiveReads(turnFixture());
      expect(called).toEqual([key]);
      expect(result.failed).toEqual([]);
    }
  });

  it('模块卡住时在截止时间内被放弃，对话不必等它', async () => {
    const manager = await loadManager();
    db.row = { emotionEnabled: true };
    manager.registerCognitiveModule({
      key: 'emotion',
      read: () => new Promise(() => undefined)
    });

    const started = Date.now();
    const result = await manager.runCognitiveReads(turnFixture());

    expect(result.failed).toEqual(['emotion']);
    expect(Date.now() - started).toBeLessThan(manager.COGNITIVE_MODULE_DEADLINE_MS + 1500);
  });
});

describe('认知模块的写侧', () => {
  it('写侧同样按开关过滤，且失败不外抛', async () => {
    const manager = await loadManager();
    db.row = { memoryEnabled: true, userModelEnabled: true };
    const written: string[] = [];
    let emotionWrites = 0;
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => Promise.resolve([]),
      write: (turn) => {
        written.push(turn.userId);
        return Promise.resolve();
      }
    });
    manager.registerCognitiveModule({
      key: 'userModel',
      read: () => Promise.resolve([]),
      write: () => Promise.reject(new Error('画像写挂了'))
    });
    manager.registerCognitiveModule({
      key: 'emotion',
      read: () => Promise.resolve([]),
      write: () => {
        emotionWrites += 1;
        return Promise.resolve();
      }
    });

    await expect(manager.runCognitiveWrites(turnFixture())).resolves.toEqual({
      attempted: ['memory', 'userModel'],
      failed: [{ module: 'userModel', reason: 'error' }]
    });
    expect(written).toEqual(['user-a']);
    expect(emotionWrites).toBe(0);
    expect(JSON.stringify(db.warns)).not.toContain('画像写挂了');
  });

  it('写侧同步抛错也算一条失败，harness 自己不 reject', async () => {
    const manager = await loadManager();
    db.row = { memoryEnabled: true };
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => Promise.resolve([]),
      // 同步抛错（而不是返回 rejected promise）。以前靠外面那层 queueCognitiveWrites 接住，
      // 现在入队改成落库，「永不 reject」这条契约归 runCognitiveWrites 自己——worker 直接 await 它。
      write: () => {
        throw new Error('写入失败，原文：我今天不太想聊工作');
      }
    });

    await expect(manager.runCognitiveWrites(turnFixture())).resolves.toEqual({
      attempted: ['memory'],
      failed: [{ module: 'memory', reason: 'error' }]
    });
    expect(db.warns.map((entry) => entry[0])).toContain('cognitive.write_failed');
    expect(JSON.stringify(db.warns)).not.toContain('我今天不太想聊工作');
  });

  it('写成功时不打失败日志', async () => {
    const manager = await loadManager();
    db.row = { memoryEnabled: true };
    manager.registerCognitiveModule({ key: 'memory', read: () => Promise.resolve([]), write: () => Promise.resolve() });

    await expect(manager.runCognitiveWrites(turnFixture())).resolves.toEqual({ attempted: ['memory'], failed: [] });

    expect(db.warns).toEqual([]);
  });

  it('写侧的截止由调用方给：后台任务等得起，读侧仍然卡一秒就放弃', async () => {
    const manager = await loadManager();
    vi.useFakeTimers();
    try {
      db.row = { memoryEnabled: true, emotionEnabled: true };
      manager.registerCognitiveModule({
        key: 'memory',
        read: () => Promise.resolve([]),
        write: () => new Promise(() => undefined)
      });
      manager.registerCognitiveModule({ key: 'emotion', read: () => new Promise(() => undefined) });

      const writes = manager.runCognitiveWrites(turnFixture(), 20_000);
      const reads = manager.runCognitiveReads(turnFixture());

      await vi.advanceTimersByTimeAsync(1_500);
      expect(await reads).toMatchObject({ failed: ['emotion'] });

      let writeDone = false;
      void writes.then(() => {
        writeDone = true;
      });
      await vi.advanceTimersByTimeAsync(18_000);
      expect(writeDone).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(writes).resolves.toMatchObject({ failed: [{ module: 'memory', reason: 'timeout' }] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('开关本身读不出来时', () => {
  it('认知引擎整体退化成「什么都没做」，对话不受影响', async () => {
    const manager = await loadManager();
    db.throws = true;
    db.row = { memoryEnabled: true };
    manager.registerCognitiveModule({
      key: 'memory',
      read: () => Promise.resolve([{ module: 'memory', label: '相关记忆', text: '用户的孩子叫小满' }])
    });

    const result = await manager.runCognitiveReads(turnFixture());

    expect(result).toEqual({ blocks: [], failed: [] });
    expect(JSON.stringify(db.warns)).not.toContain('数据库连接断了');
  });
});
