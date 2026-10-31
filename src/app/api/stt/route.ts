import { prisma } from '@/lib/prisma';
import { api, ApiError, getRequestIp, readMultipartLimited, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { inspectUpload } from '@/lib/files';
import { capabilitiesOf, resolveDefaultProvider } from '@/lib/providers';
import { transcribeAudio } from '@/lib/ai';
import { ApiError as ApiErr } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`stt:${user.id}`, 12, 60 * 1000);
    if (!limit.ok) throw new ApiErr(429, 'RATE_LIMITED', '语音转写过于频繁，请稍后再试');
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '必须使用 multipart/form-data');
    }
    const form = await readMultipartLimited(req, 16 * 1024 * 1024);
    const file = form.get('audio');
    if (!(file instanceof File)) throw new ApiError(400, 'MISSING_AUDIO', '没有收到音频');
    if (file.size > 15 * 1024 * 1024) throw new ApiError(413, 'AUDIO_TOO_LARGE', '音频文件过大');
    const buffer = Buffer.from(await file.arrayBuffer());
    const inspected = await inspectUpload({
      buffer,
      filename: file.name || 'voice.webm',
      declaredMime: file.type
    });
    if (inspected.kind !== 'AUDIO') throw new ApiError(400, 'NOT_AUDIO', '上传的文件不是音频');

    const rows = await prisma.aiProvider.findMany({
      where: {
        enabled: true,
        OR: [{ ownerType: 'GLOBAL' }, { ownerType: 'USER', userId: user.id }]
      },
      orderBy: [{ ownerType: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }]
    });
    let provider = rows.find((p) => capabilitiesOf(p).includes('audio')) || null;
    if (!provider) {
      try {
        const fallback = await resolveDefaultProvider(user.id);
        if (capabilitiesOf(fallback).includes('audio')) provider = fallback;
      } catch {
        /* handled below */
      }
    }
    if (!provider) {
      throw new ApiError(400, 'NO_AUDIO_MODEL', '管理员尚未配置支持语音转写的模型；可改用浏览器语音输入');
    }
    const text = await transcribeAudio({
      provider,
      buffer,
      filename: inspected.name,
      mime: inspected.mime,
      signal: req.signal
    });
    return { text, provider: provider.name };
  });
}
