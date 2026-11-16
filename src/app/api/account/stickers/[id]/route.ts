import { requireUser } from '@/lib/auth';
import { api, ApiError, readJson } from '@/lib/http';
import { deletePersonalSticker, parseStickerLabel, readPersonalSticker, updatePersonalSticker } from '@/lib/personal-stickers';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit(`sticker-download:${user.id}`, 600, 60_000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '表情包读取过于频繁，请稍后重试');
    }
    const { id } = await params;
    const { mime, bytes } = await readPersonalSticker(user.id, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer'
      }
    });
  });
}

export async function PATCH(req: Request, { params }: Context) {
  return api(async () => {
    const { user } = await requireUser(req);
    const patch = await readJson(req) as { enabled?: unknown; label?: unknown } | null;
    if (!patch || typeof patch !== 'object' ||
        (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
        (patch.enabled === undefined && patch.label === undefined)) {
      throw new ApiError(400, 'STICKER_UPDATE', '表情包设置无效');
    }
    const { id } = await params;
    const sticker = await updatePersonalSticker(user.id, id, {
      enabled: patch.enabled,
      label: patch.label === undefined ? undefined : parseStickerLabel(patch.label)
    });
    return { sticker };
  });
}

export async function DELETE(req: Request, { params }: Context) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await params;
    await deletePersonalSticker(user.id, id);
    return { deleted: true };
  });
}
