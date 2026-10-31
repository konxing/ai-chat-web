import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import {
  attachmentName,
  deleteAttachmentAndFile,
  getAttachmentForUser,
  readAttachmentBuffer
} from '@/lib/files';
import { ApiError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'file';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const attachment = await getAttachmentForUser(id, user.id);
    // storageKey 是 UUID、行只删不改，内容事实上不可变：命中 ETag 就不必再读盘解密。
    const etag = `"${attachment.sha256}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' }
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
        'Cache-Control': 'private, max-age=31536000, immutable',
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

