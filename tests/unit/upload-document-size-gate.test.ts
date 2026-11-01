import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 文档走的是「抽文本进上下文」这条路，所以它的体积上限和图片不是一回事：
 * 300MB 的原件存得下，但 unpdf/mammoth 在 50MB 以上的文件上要么抽不出来、
 * 要么把整个进程的内存吃掉。这里的规则是原件照收、超过 50MB 不抽，UI 上说明白。
 */
const MB = 1024 * 1024;

const spies = vi.hoisted(() => ({
  rows: [] as Array<{ key: string; value: unknown }>,
  pdf: vi.fn(() => Promise.resolve({ text: ['论文正文'] })),
  docx: vi.fn(() => Promise.resolve({ value: '文档正文' }))
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: { findMany: () => Promise.resolve(spies.rows) }
  }
}));

vi.mock('unpdf', () => ({ extractText: spies.pdf }));
vi.mock('mammoth', () => ({ default: { extractRawText: spies.docx } }));

function pdf(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write('%PDF-1.7\n', 0, 'ascii');
  return buffer;
}

function docx(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write('PK\x03\x04', 0, 'binary');
  return buffer;
}

async function inspect(buffer: Buffer, filename: string, declaredMime?: string) {
  const { inspectUpload } = await import('@/lib/files');
  return inspectUpload({ buffer, filename, declaredMime });
}

beforeEach(() => {
  spies.rows = [];
  spies.pdf.mockClear();
  spies.docx.mockClear();
});

describe('文档上传体积上限', () => {
  it('默认上限就是 300MB：20MB 那道旧闸早把长文档挡在外面了', async () => {
    const { maxUploadBytes } = await import('@/lib/files');

    expect(await maxUploadBytes()).toBe(300 * MB);
  });

  it('管理员可以把上限填到 320MB，再多就不收', async () => {
    const { adminConfigSchema } = await import('@/lib/validation');

    expect(adminConfigSchema.parse({ maxUploadMB: 320 }).maxUploadMB).toBe(320);
    expect(adminConfigSchema.safeParse({ maxUploadMB: 321 }).success).toBe(false);
  });

  it('配置行里写了越界的数，读取时回落默认而不是照用', async () => {
    spies.rows = [{ key: 'maxUploadMB', value: 9999 }];
    const { getSystemSettings } = await import('@/lib/config');
    const { maxUploadBytes } = await import('@/lib/files');

    expect((await getSystemSettings()).maxUploadMB).toBe(300);
    expect(await maxUploadBytes()).toBe(300 * MB);
  });
});

describe('50MB 以上的文档跳过文本抽取', () => {
  it('51MB 的 PDF 收下来，但根本不进解析器', async () => {
    const info = await inspect(pdf(51 * MB), 'thesis.pdf', 'application/pdf');

    expect(info.kind).toBe('FILE');
    expect(info.text).toBeNull();
    expect(info.textSkipped).toBe(true);
    expect(spies.pdf).not.toHaveBeenCalled();
  });

  it('51MB 的 DOCX 同样跳过', async () => {
    const info = await inspect(docx(51 * MB), 'report.docx');

    expect(info.kind).toBe('FILE');
    expect(info.text).toBeNull();
    expect(info.textSkipped).toBe(true);
    expect(spies.docx).not.toHaveBeenCalled();
  });

  it('50MB 整的 PDF 还在闸内，照旧抽出文本并分块', async () => {
    const info = await inspect(pdf(50 * MB), 'paper.pdf', 'application/pdf');

    expect(info.text).toBe('论文正文');
    expect(info.textSkipped).toBe(false);
    expect(info.chunks).toEqual(['论文正文']);
    expect(spies.pdf).toHaveBeenCalledTimes(1);
  });

  it('图片不受这条闸影响：它本来就不抽文本', async () => {
    const png = Buffer.alloc(2 * MB);
    png.write('\x89PNG\r\n\x1a\n', 0, 'binary');

    const info = await inspect(png, 'photo.png', 'image/png');

    expect(info.kind).toBe('IMAGE');
    expect(info.textSkipped).toBe(false);
  });

  it('列表接口把「过大未解析」说清楚，不让用户以为模型读到了内容', async () => {
    const { publicAttachment } = await import('@/lib/files');
    const summary = {
      id: 'a1',
      kind: 'FILE' as const,
      mime: 'application/pdf',
      size: 51 * MB,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      originalNameCiphertext: '',
      extractedTextCiphertext: null
    };

    expect(publicAttachment(summary).textSkipped).toBe(true);
    expect(publicAttachment({ ...summary, size: 1 * MB }).textSkipped).toBe(false);
    expect(publicAttachment({ ...summary, extractedTextCiphertext: 'x' }).textSkipped).toBe(false);
  });
});
