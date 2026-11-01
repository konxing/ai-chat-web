import { describe, expect, it, vi } from 'vitest';

/**
 * 图片单张 8MB 是上传时就该硬拒的边界：以前只在「发给模型」那一步把 >8MB 的图静默丢掉，
 * 用户看见的是「上传成功、模型却像没看到图」。文档不受这个数影响——文档进模型的是
 * 抽出来的文本，不是原始字节。
 */
vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: { findMany: () => Promise.resolve([]) }
  }
}));

const MB = 1024 * 1024;

function png(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  return buffer;
}

function pdf(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write('%PDF-1.7\n', 0, 'ascii');
  return buffer;
}

async function inspect(buffer: Buffer, filename: string, declaredMime?: string) {
  const { inspectUpload } = await import('@/lib/files');
  return inspectUpload({ buffer, filename, declaredMime });
}

describe('图片单张 8MB 上限', () => {
  it('正好 8MB 的 PNG 收下来，kind 是 IMAGE', async () => {
    const info = await inspect(png(MB * 8), 'photo.png', 'image/png');

    expect(info.kind).toBe('IMAGE');
    expect(info.mime).toBe('image/png');
  });

  it('8MB 多一个字节就 413，并且说清楚是图片的限制', async () => {
    let caught: unknown;
    try {
      await inspect(png(MB * 8 + 1), 'photo.png', 'image/png');
    } catch (err) {
      caught = err;
    }

    const { ApiError } = await import('@/lib/http');
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).status).toBe(413);
    expect((caught as InstanceType<typeof ApiError>).message).toBe('图片超过 8MB 限制');
  });

  it('同样超过 8MB 的 PDF 照收：8MB 只钉图片', async () => {
    const info = await inspect(pdf(MB * 9), 'paper.pdf', 'application/pdf');

    expect(info.kind).toBe('FILE');
    expect(info.mime).toBe('application/pdf');
  });
});
