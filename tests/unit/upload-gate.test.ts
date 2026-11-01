import { describe, expect, it, vi } from 'vitest';

type UploadGate = typeof import('@/lib/upload-gate');

/** 队列是进程内的全局状态，每个用例都要拿到一份干净的模块实例。 */
async function freshGate(): Promise<UploadGate> {
  vi.resetModules();
  return await import('@/lib/upload-gate');
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('上传串行闸', () => {
  it('一次只放行一个：第二个 acquire 必须等第一个 release', async () => {
    const gate = await freshGate();

    const release1 = await gate.acquireUploadSlot();
    let secondGranted = false;
    const second = gate.acquireUploadSlot().then((release) => {
      secondGranted = true;
      return release;
    });

    await tick();
    expect(secondGranted).toBe(false);

    release1();
    const release2 = await second;
    expect(secondGranted).toBe(true);
    release2();
  });

  it('1 个在跑加 2 个排队之后，第 4 个立刻被拒而不是继续占内存', async () => {
    const gate = await freshGate();
    const { ApiError } = await import('@/lib/http');

    const release1 = await gate.acquireUploadSlot();
    const queued2 = gate.acquireUploadSlot();
    const queued3 = gate.acquireUploadSlot();

    let caught: unknown;
    try {
      await gate.acquireUploadSlot();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).status).toBe(429);
    expect((caught as InstanceType<typeof ApiError>).message).toBe('正在处理其他上传，请稍后再试');

    release1();
    const release2 = await queued2;
    release2();
    const release3 = await queued3;
    release3();
  });

  it('排队者按先进先出拿到槽', async () => {
    const gate = await freshGate();

    const order: string[] = [];
    const release1 = await gate.acquireUploadSlot();
    const second = gate.acquireUploadSlot().then((release) => {
      order.push('second');
      return release;
    });
    await tick();
    const third = gate.acquireUploadSlot().then((release) => {
      order.push('third');
      return release;
    });
    await tick();

    release1();
    (await second)();
    (await third)();

    expect(order).toEqual(['second', 'third']);
  });

  it('任务抛错时 withUploadSlot 也把槽归还，不会把闸卡死', async () => {
    const gate = await freshGate();

    await expect(
      gate.withUploadSlot(() => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');

    const release = await gate.acquireUploadSlot();
    expect(release).toBeTypeOf('function');
    release();
  });

  it('withUploadSlot 原样返回任务结果', async () => {
    const gate = await freshGate();

    const result = await gate.withUploadSlot(() => Promise.resolve('saved'));

    expect(result).toBe('saved');
  });
});
