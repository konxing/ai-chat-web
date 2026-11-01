import { ApiError } from './http';

/**
 * 一次上传在进程里会同时存在「请求整包 + File + Buffer + 加密输出」四份副本，
 * 300MB 的文件传一份就是 1GB 多的常驻内存。限流只管次数不管重量，所以这里再补
 * 一道形状上的闸：同一时刻只放一个上传进入读盘+加密，最多两个人排队，第三个
 * 直接吃 429——反正它连 body 都还没开始读。
 */
const MAX_QUEUED = 2;

let running = false;
const waiting: Array<() => void> = [];

export function acquireUploadSlot(): Promise<() => void> {
  if (!running && waiting.length === 0) {
    running = true;
    return Promise.resolve(release());
  }
  if (waiting.length >= MAX_QUEUED) {
    return Promise.reject(new ApiError(429, 'UPLOAD_QUEUE_FULL', '正在处理其他上传，请稍后再试'));
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running = true;
      resolve(release());
    });
  });
}

export async function withUploadSlot<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireUploadSlot();
  try {
    return await task();
  } finally {
    release();
  }
}

function release(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running = false;
    const next = waiting.shift();
    if (next) next();
  };
}
