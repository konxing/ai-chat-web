import { describe, expect, it, vi } from 'vitest';

/**
 * 两个数量上限：一条消息最多挂 15 个附件；15 张图里真正转 base64 发给模型的只有前 4 张
 * （4×8MB 图片 base64 后约 43MB，再多就是服务商请求体上限的事，不是我们的）。
 * 图片落盘/解密走真实路径，只 mock prisma 的两张表。
 */
vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: { findMany: () => Promise.resolve([]) },
    attachment: {
      create: ({ data }: { data: Record<string, any> }) => Promise.resolve({ ...data })
    }
  }
}));

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';

function png(): Buffer {
  const buffer = Buffer.alloc(512);
  buffer.write(PNG_SIGNATURE, 0, 'binary');
  return buffer;
}

function uuids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
}

async function storeImages(count: number) {
  const { storeUpload } = await import('@/lib/files');
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(
      await storeUpload({
        userId: 'upload-count-user',
        chatId: 'chat-1',
        buffer: png(),
        filename: `photo-${index}.png`,
        declaredMime: 'image/png'
      })
    );
  }
  return rows;
}

describe('一条消息的附件数上限', () => {
  it('15 个附件通过', async () => {
    const { sendMessageSchema } = await import('@/lib/validation');

    const parsed = sendMessageSchema.safeParse({ content: '看照片', attachmentIds: uuids(15) });

    expect(parsed.success).toBe(true);
  });

  it('16 个附件被拒，并说明最多 15 个', async () => {
    const { sendMessageSchema } = await import('@/lib/validation');

    const parsed = sendMessageSchema.safeParse({ content: '看照片', attachmentIds: uuids(16) });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe('一条消息最多 15 个附件');
  });
});

describe('发给模型的图片张数上限', () => {
  it('15 张图只送出前 4 个 data URL，顺序保持', async () => {
    const { imageDataUrls } = await import('@/lib/files');
    const rows = await storeImages(15);

    const urls = await imageDataUrls(rows as never);

    expect(urls).toHaveLength(4);
    for (const url of urls) expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('可选图片同样只给 4 张——路由要靠它算出「另外 N 张未发送」', async () => {
    const { selectableImages } = await import('@/lib/files');
    const rows = await storeImages(15);
    const ids = rows.map((row) => row.id);

    const picked = selectableImages(rows as never);

    expect(picked).toHaveLength(4);
    expect(picked.map((row) => row.id)).toEqual(ids.slice(0, 4));
  });

  it('不足 4 张全送去', async () => {
    const { imageDataUrls } = await import('@/lib/files');
    const rows = await storeImages(3);

    expect(await imageDataUrls(rows as never)).toHaveLength(3);
  });

  it('发送统计算给客户端看：发出几张、这轮又漏掉几张', async () => {
    const { imageSendSummary } = await import('@/lib/files');

    expect(imageSendSummary((await storeImages(15)) as never)).toEqual({ sent: 4, skipped: 11 });
    expect(imageSendSummary((await storeImages(3)) as never)).toEqual({ sent: 3, skipped: 0 });
  });
});
