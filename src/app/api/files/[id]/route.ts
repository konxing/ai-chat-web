import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import {
  attachmentName,
  deleteAttachmentAndFile,
  getAttachmentForUser,
  readAttachmentBuffer
} from '@/lib/files';
import { ApiError } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'file';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    // 闸开在任何附件读之前：这个入口真正的代价是「整份文件读回内存 + 解密」，
    // 放在 getAttachmentForUser 之后就只是把已经干完的活再拒一次。
    // 600/分钟而不是照抄上传的 120：一页 60 条消息、每条最多 15 个附件，图片还是懒加载，
    // 快速划过照片密集的历史就能上百次请求，而 429 落在 <img> 上只是一张坏图。
    // 这条上限拦的是失控的循环和刷接口的脚本，不是人的浏览；它数的是次数，不是字节。
    const limit = rateLimit(`download:${user.id}`, 600, 60 * 1000);
    if (!limit.ok) throw new ApiError(429, 'RATE_LIMITED', '文件读取过于频繁，请稍后再试');
    const { id } = await ctx.params;
    const attachment = await getAttachmentForUser(id, user.id);
    // storageKey 是 UUID、行只删不改，内容事实上不可变：命中 ETag 就不必再读盘解密。
    const etag = `"${attachment.sha256}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'private, no-store' }
      });
    }
    const buffer = await readAttachmentBuffer(attachment);
    const url = new URL(req.url);
    const inline = url.searchParams.get('inline') === '1' && ['IMAGE', 'AUDIO'].includes(attachment.kind);
    const name = attachmentName(attachment);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': attachment.mime,
        'Content-Length': String(buffer.length),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
        // A browser profile can be used by different accounts. Require a fresh
        // authorization check instead of allowing it to reuse decrypted files.
        'Cache-Control': 'private, no-store',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer'
      }
    });
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const attachment = await getAttachmentForUser(id, user.id);
    if (attachment.messageId) {
      throw new ApiError(400, 'ATTACHMENT_IN_USE', '该文件已用于消息，不能单独删除');
    }
    await deleteAttachmentAndFile(attachment);
    return { deleted: true };
  });
}

