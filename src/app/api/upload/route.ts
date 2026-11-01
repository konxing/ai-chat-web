import { api, ApiError, getRequestIp, readMultipartLimited, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getChatOwned } from '@/lib/chats';
import { maxUploadBytes, publicAttachment, storeUpload } from '@/lib/files';
import { rateLimit } from '@/lib/rate-limit';
import { withUploadSlot } from '@/lib/upload-gate';
import { ApiError as ApiErr } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    // 一次批量传图就是十几二十个请求，30/分钟会把正常用户掐在半路上；
    // 真正兜住内存的是下面的串行闸，不是这里的次数。
    const limit = rateLimit(`upload:${user.id}`, 120, 60 * 1000);
    if (!limit.ok) throw new ApiErr(429, 'RATE_LIMITED', '上传过于频繁，请稍后再试');

    const maxBytes = await maxUploadBytes();
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > maxBytes + 1_000_000) {
      throw new ApiError(413, 'FILE_TOO_LARGE', '上传内容过大');
    }
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '必须使用 multipart/form-data');
    }

    return withUploadSlot(async () => {
      const form = await readMultipartLimited(req, maxBytes + 1_000_000);
      const file = form.get('file');
      const chatId = String(form.get('chatId') || '');
      if (!(file instanceof File)) throw new ApiError(400, 'MISSING_FILE', '没有选择文件');
      if (!chatId) throw new ApiError(400, 'MISSING_CHAT', '上传必须关联到会话');
      await getChatOwned(chatId, user.id);
      if (file.size > maxBytes) {
        throw new ApiError(413, 'FILE_TOO_LARGE', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`);
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const attachment = await storeUpload({
        userId: user.id,
        chatId,
        buffer,
        filename: file.name,
        declaredMime: file.type
      });
      return { attachment: publicAttachment(attachment) };
    });
  });
}
