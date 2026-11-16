import { requireUser } from '@/lib/auth';
import { PERSONAL_STICKER_MAX_BYTES } from '@/lib/chat-stickers';
import { maxUploadBytes } from '@/lib/files';
import { api, ApiError, readMultipartLimited } from '@/lib/http';
import { importPersonalSticker, listPersonalStickers, parseStickerLabel } from '@/lib/personal-stickers';
import { rateLimit } from '@/lib/rate-limit';
import { withUploadSlot } from '@/lib/upload-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return {
      stickers: await listPersonalStickers(user.id),
      maxFileBytes: Math.min(PERSONAL_STICKER_MAX_BYTES, await maxUploadBytes())
    };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit(`sticker-upload:${user.id}`, 75, 60_000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '导入过于频繁，请稍后重试');
    }
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请上传表情图片文件');
    }
    const maxBytes = Math.min(PERSONAL_STICKER_MAX_BYTES, await maxUploadBytes());
    return withUploadSlot(async () => {
      const form = await readMultipartLimited(req, maxBytes + 8_192);
      const file = form.get('file');
      if (!(file instanceof File)) throw new ApiError(400, 'MISSING_FILE', '请选择一张表情包');
      if (file.size > maxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', '表情包超过当前上传大小限制');
      const label = parseStickerLabel(form.get('label'));
      return { sticker: await importPersonalSticker(user.id, label, Buffer.from(await file.arrayBuffer())) };
    });
  });
}
