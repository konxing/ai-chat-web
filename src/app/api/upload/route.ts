import { api, ApiError, getRequestIp, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getChatOwned } from '@/lib/chats';
import { maxUploadBytes, publicAttachment, storeUpload } from '@/lib/files';
import { rateLimit } from '@/lib/rate-limit';
import { ApiError as ApiErr } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`upload:${user.id}`, 30, 60 * 1000);
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

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError(400, 'INVALID_FORM', '上传表单无效');
    }
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
}
