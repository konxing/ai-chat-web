import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSONAL_STICKER_MAX_ITEMS } from '@/lib/chat-stickers';
import { stickerImageMime } from '@/lib/sticker-image';

type StickerRow = {
  id: string; userId: string; digest: string; enabled: boolean;
  labelCiphertext: string; imageCiphertext: Uint8Array; size: number; mime: string;
};
type Scope = { id?: string; userId: string; enabled?: boolean };

const { rows, session } = vi.hoisted(() => ({
  rows: new Map<string, StickerRow>(),
  session: { userId: 'test-sticker-alice' }
}));

vi.mock('@/lib/auth', () => ({
  requireUser: async () => ({ user: { id: session.userId } })
}));
vi.mock('@/lib/files', () => ({ maxUploadBytes: async () => 4 * 1024 * 1024 }));
vi.mock('@/lib/prisma', () => {
  const query = (where: Scope) => Array.from(rows.values()).filter((row) =>
    row.userId === where.userId && (!where.id || where.id === row.id) &&
    (where.enabled === undefined || where.enabled === row.enabled)
  );
  const personalSticker = {
    findMany: async ({ where }: { where: Scope }) => query(where),
    findFirst: async ({ where }: { where: Scope }) => query(where)[0],
    aggregate: async ({ where }: { where: Scope }) => ({
      _count: { _all: query(where).length },
      _sum: { size: query(where).reduce((sum, row) => sum + row.size, 0) }
    }),
    create: async ({ data }: { data: StickerRow }) => {
      if (query({ userId: data.userId }).some((row) => row.digest === data.digest)) throw { code: 'P2002' };
      rows.set(data.id, { ...data, enabled: true });
    },
    update: async ({ where, data }: { where: Scope; data: Partial<StickerRow> }) => {
      const row = query(where)[0];
      if (!row) throw { code: 'P2025' };
      return Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
    },
    deleteMany: async ({ where }: { where: Scope }) => {
      const matched = query(where);
      matched.forEach((row) => rows.delete(row.id));
      return { count: matched.length };
    }
  };
  return {
    prisma: {
      personalSticker,
      $transaction: async (fn: (tx: { personalSticker: typeof personalSticker }) => Promise<unknown>) => fn({ personalSticker })
    }
  };
});

import { GET as list, POST as upload } from '@/app/api/account/stickers/route';
import { DELETE as remove, GET as read, PATCH as update } from '@/app/api/account/stickers/[id]/route';
import { listPersonalStickers } from '@/lib/personal-stickers';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const frameOffset = gif.indexOf(0x2c);
const animation = Buffer.concat([gif.subarray(0, -1), gif.subarray(frameOffset)]);
const png = readFileSync('public/stickers/wave.png');
const url = 'http://127.0.0.1:3000/api/account/stickers';

function uploadRequest(bytes: Buffer, label = '开心小猫') {
  const form = new FormData();
  // Browsers and exports may leave the MIME empty. Header validation decides.
  form.set('file', new File([new Uint8Array(bytes)], '表情'));
  form.set('label', label);
  return new Request(url, { method: 'POST', body: form });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function disableRequest(stickerUrl: string) {
  return new Request(stickerUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}'
  });
}

describe('personal sticker import', () => {
  beforeEach(() => {
    session.userId = 'test-sticker-alice';
    rows.clear();
  });

  it('sniffs real PNG and GIF while rejecting SVG, truncated images and oversized dimensions', () => {
    expect(stickerImageMime(png)).toBe('image/png');
    expect(stickerImageMime(gif)).toBe('image/gif');
    expect(stickerImageMime(animation)).toBe('image/gif');
    expect(() => stickerImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow('仅支持');
    expect(() => stickerImageMime(gif.subarray(0, -1))).toThrow('图片损坏');
    const tooLarge = Buffer.from(gif);
    tooLarge.writeUInt16LE(8000, 6);
    expect(() => stickerImageMime(tooLarge)).toThrow('过大');
  });

  it('validates input labels and enforces the library quota', async () => {
    const badLabel = await upload(uploadRequest(gif, '[[STICKER:requested:wave]]'));
    expect(badLabel.status).toBe(400);
    expect(rows.size).toBe(0);
    for (let i = 0; i < PERSONAL_STICKER_MAX_ITEMS; i++) {
      rows.set(`u${i.toString(16).padStart(32, '0')}`, {
        id: `u${i.toString(16).padStart(32, '0')}`, userId: session.userId, digest: '', size: gif.length,
        enabled: false, labelCiphertext: '', imageCiphertext: new Uint8Array(), mime: 'image/gif'
      });
    }
    expect((await upload(uploadRequest(gif))).status).toBe(409);
  });

  it('encrypts original bytes, scopes library/image/mutations to the owner and preserves disabled history', async () => {
    const uploaded = await upload(uploadRequest(animation));
    expect(uploaded.status).toBe(200);
    const { data: { sticker: { id } } } = await uploaded.json();
    const row = rows.get(id)!;
    expect(row.labelCiphertext).not.toContain('开心小猫');
    expect(Buffer.from(row.imageCiphertext)).not.toEqual(animation);
    expect((await upload(uploadRequest(animation))).status).toBe(409);
    const stickerUrl = `${url}/${id}`;

    session.userId = 'test-sticker-bob';
    expect((await (await list(new Request(url))).json()).data.stickers).toEqual([]);
    expect((await read(new Request(stickerUrl), context(id))).status).toBe(404);
    expect((await remove(new Request(stickerUrl, { method: 'DELETE' }), context(id))).status).toBe(404);
    expect((await update(disableRequest(stickerUrl), context(id))).status).toBe(404);

    session.userId = 'test-sticker-alice';
    const disable = await update(disableRequest(stickerUrl), context(id));
    expect(disable.status).toBe(200);
    expect(await listPersonalStickers(session.userId, true)).toEqual([]);
    const image = await read(new Request(stickerUrl), context(id));
    expect(image.headers.get('content-type')).toBe('image/gif');
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(animation);
  });
});
