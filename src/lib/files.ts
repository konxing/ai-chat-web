import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, AttachmentKind, Prisma } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import { prisma } from './prisma';
import { decryptBuffer, decryptString, encryptBuffer, encryptString, sha256Hex } from './crypto';
import { ApiError } from './http';
import { loadEnv } from './env';
import { getSystemSettings } from './config';
import { log } from './logger';

interface AllowedType {
  mime: string;
  kind: AttachmentKind;
  extensions: string[];
}

const ALLOWED: AllowedType[] = [
  { mime: 'image/png', kind: 'IMAGE', extensions: ['png'] },
  { mime: 'image/jpeg', kind: 'IMAGE', extensions: ['jpg', 'jpeg'] },
  { mime: 'image/webp', kind: 'IMAGE', extensions: ['webp'] },
  { mime: 'image/gif', kind: 'IMAGE', extensions: ['gif'] },
  { mime: 'application/pdf', kind: 'FILE', extensions: ['pdf'] },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'FILE',
    extensions: ['docx']
  },
  { mime: 'audio/webm', kind: 'AUDIO', extensions: ['webm'] },
  { mime: 'audio/ogg', kind: 'AUDIO', extensions: ['ogg', 'oga'] },
  { mime: 'audio/mpeg', kind: 'AUDIO', extensions: ['mp3'] },
  { mime: 'audio/wav', kind: 'AUDIO', extensions: ['wav'] },
  { mime: 'audio/mp4', kind: 'AUDIO', extensions: ['m4a', 'mp4'] }
];

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv']);

/**
 * 图片按张算上限，和文档共用那个数是两回事：图片是 base64 原样进请求体的，
 * 文档进模型的是抽出来的文本。所以 8MB 只钉图片，超了在上传时就拒掉——
 * 以前是收下来再在「发给模型」那一步静默丢弃，用户只看见模型像没看到图。
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 一次请求最多送几张图给模型。图片是 base64 原样进请求体的，4 张 8MB 图就是几十 MB 出站，
 * 再多会撞服务商的请求体上限——所以「挂得上」和「发得出去」是两个数。
 */
export const MAX_IMAGES_PER_REQUEST = 4;

/**
 * 这一次能进请求的图片：先过体积闸（库里可能还有规则之前收进来的大图），再截前 N 张。
 * imageDataUrls 和「另外 N 张未发送」的提示共用它，规则只写一遍。
 */
export function selectableImages(attachments: Attachment[]): Attachment[] {
  return attachments
    .filter((a) => a.kind === 'IMAGE' && a.size <= IMAGE_MAX_BYTES)
    .slice(0, MAX_IMAGES_PER_REQUEST);
}

/** 这一轮图片「发出几张、剩下几张没进模型」，规则只在 selectableImages 里写一遍。 */
export function imageSendSummary(attachments: Attachment[]): { sent: number; skipped: number } {
  const total = attachments.filter((a) => a.kind === 'IMAGE').length;
  const sent = selectableImages(attachments).length;
  return { sent, skipped: total - sent };
}

/**
 * 原件存得下不等于解析得起：unpdf 和 mammoth 都是把整份文件在内存里展开的，
 * 50MB 的 PDF 抽一次能吃掉几百 MB。超过这条线就只存原件，并把这个事实告诉前端——
 * 用户看见的不能是「上传成功」然后以为模型读到了内容。
 */
export const TEXT_PARSE_MAX_BYTES = 50 * 1024 * 1024;

const PARSED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

/** 图片本来就抽不出文本，不算「跳过」；只有本该抽却没有抽的才需要在界面上说明。 */
function parseSkippedFor(mime: string, size: number): boolean {
  return PARSED_MIMES.has(mime) && size > TEXT_PARSE_MAX_BYTES;
}

export interface InspectedUpload {
  kind: AttachmentKind;
  mime: string;
  extension: string;
  name: string;
  text: string | null;
  chunks: string[] | null;
  textSkipped: boolean;
}

function safeFilename(input: string): string {
  const base = path.basename(input.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'file').slice(0, 180);
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase();
}

/**
 * 分块是有损索引：最多 200 块，超出上限之后的正文不进 chunks。
 * 所以 extractedTextCiphertext 不能被 chunks 取代——它是长文档唯一完整的原文副本，
 * 也是没有分块时的兜底检索源。两列都留着不是冗余。
 */
function chunkText(text: string, size = 3000, overlap = 200): string[] {
  const chunks: string[] = [];
  const maxChunks = 200;
  let offset = 0;
  while (offset < text.length && chunks.length < maxChunks) {
    const end = Math.min(text.length, offset + size);
    chunks.push(text.slice(offset, end));
    if (end >= text.length) break;
    offset += size - overlap;
  }
  return chunks;
}

export async function maxUploadBytes(): Promise<number> {
  const env = loadEnv();
  const settings = await getSystemSettings();
  const fromSettings = settings.maxUploadMB;
  return Math.min(env.MAX_UPLOAD_MB, fromSettings) * 1024 * 1024;
}

export async function inspectUpload(input: {
  buffer: Buffer;
  filename: string;
  declaredMime?: string;
}): Promise<InspectedUpload> {
  const name = safeFilename(input.filename);
  const ext = extensionOf(name);
  const maxBytes = await maxUploadBytes();
  if (input.buffer.length === 0) throw new ApiError(400, 'EMPTY_FILE', '文件为空');
  if (input.buffer.length > maxBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input.buffer);
    } catch {
      throw new ApiError(400, 'INVALID_TEXT', '文本文件不是有效的 UTF-8 编码');
    }
    if (text.includes('\u0000')) throw new ApiError(400, 'INVALID_TEXT', '文本文件包含二进制内容');
    if (text.length > 2_000_000) throw new ApiError(413, 'TEXT_TOO_LARGE', '文本内容过长（最多 200 万字符）');
    const mime = ext === 'csv' ? 'text/csv' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
    return {
      kind: 'FILE',
      mime,
      extension: ext,
      name,
      text,
      chunks: chunkText(text),
      textSkipped: false
    };
  }

  const detected = await fileTypeFromBuffer(input.buffer);
  if (!detected) throw new ApiError(400, 'UNKNOWN_FILE_TYPE', '无法识别文件类型，仅支持 PNG/JPEG/WebP/GIF、PDF、DOCX、TXT/MD/CSV 和常见音频');
  let effectiveMime = detected.mime;
  let allowed = ALLOWED.find((t) => t.mime === effectiveMime);

  // Some DOCX files are identified as ZIP; trust the extension only for .docx and verify structure via mammoth.
  if (!allowed && detected.mime === 'application/zip' && ext === 'docx') {
    effectiveMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    allowed = ALLOWED.find((t) => t.mime === effectiveMime);
  }
  if (!allowed) throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', `不支持的文件类型：${detected.mime}`);
  if (!allowed.extensions.includes(ext)) {
    throw new ApiError(400, 'EXTENSION_MISMATCH', `文件扩展名 .${ext || '(无)'} 与内容类型不匹配`);
  }
  if (input.declaredMime && input.declaredMime !== 'application/octet-stream') {
    const declaredAllowed = ALLOWED.find((t) => t.mime === input.declaredMime);
    if (declaredAllowed && declaredAllowed.kind !== allowed.kind) {
      throw new ApiError(400, 'MIME_MISMATCH', '文件声明的类型与内容不匹配');
    }
  }

  const imageCapBytes = Math.min(maxBytes, IMAGE_MAX_BYTES);
  if (allowed.kind === 'IMAGE' && input.buffer.length > imageCapBytes) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', `图片超过 ${Math.floor(imageCapBytes / 1024 / 1024)}MB 限制`);
  }

  const textSkipped = parseSkippedFor(allowed.mime, input.buffer.length);
  let text: string | null = null;
  if (!textSkipped && effectiveMime === 'application/pdf') {
    try {
      const result = await extractText(new Uint8Array(input.buffer), { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n') : result.text;
    } catch (err) {
      log.warn('file.pdf_extract_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  } else if (!textSkipped && effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await mammoth.extractRawText({ buffer: input.buffer });
      text = result.value;
    } catch (err) {
      log.warn('file.docx_extract_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (text) {
    text = text.replace(/\u0000/g, '').slice(0, 2_000_000);
    if (!text.trim()) text = null;
  }

  return {
    kind: allowed.kind,
    mime: allowed.mime,
    extension: allowed.extensions[0],
    name,
    text,
    chunks: text ? chunkText(text) : null,
    textSkipped
  };
}

// 摘要把记录 id 折进去：同一份文件在不同用户名下不再产生可比对的相同指纹，
// 同时因为 id 永不变化，主密钥轮换也不会让历史摘要失效。
function attachmentDigest(attachmentId: string, plain: Buffer): string {
  return createHash('sha256').update(`${attachmentId}\n`, 'utf8').update(plain).digest('hex');
}

export async function storeUpload(input: {
  userId: string;
  chatId: string | null;
  buffer: Buffer;
  filename: string;
  declaredMime?: string;
}): Promise<Attachment> {
  const info = await inspectUpload(input);
  const id = randomUUID();
  const env = loadEnv();
  const root = path.resolve(env.UPLOAD_DIR);
  const dir = path.join(root, input.userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const storageKey = path.posix.join(input.userId, `${id}.enc`);
  const finalPath = path.join(root, storageKey);
  const tmpPath = path.join(dir, `.${id}.tmp`);
  const encrypted = encryptBuffer(input.buffer, `file:${id}`);
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, finalPath);
  await stat(finalPath);

  try {
    const attachment = await prisma.attachment.create({
      data: {
        id,
        userId: input.userId,
        chatId: input.chatId,
        kind: info.kind,
        originalNameCiphertext: encryptString(info.name, `attachment-name:${id}`),
        mime: info.mime,
        size: input.buffer.length,
        sha256: attachmentDigest(id, input.buffer),
        storageKey,
        extractedTextCiphertext: info.text
          ? encryptString(info.text, `attachment-text:${id}`)
          : null,
        chunksCiphertext: info.chunks
          ? encryptString(JSON.stringify(info.chunks), `attachment-chunks:${id}`)
          : null
      }
    });
    return attachment;
  } catch (err) {
    await unlink(finalPath).catch(() => undefined);
    throw err;
  }
}

export function attachmentName(attachment: Pick<Attachment, 'id' | 'originalNameCiphertext'>): string {
  try {
    return decryptString(attachment.originalNameCiphertext, `attachment-name:${attachment.id}`);
  } catch {
    return 'file';
  }
}

export function attachmentText(attachment: Attachment): string | null {
  if (!attachment.extractedTextCiphertext) return null;
  try {
    return decryptString(attachment.extractedTextCiphertext, `attachment-text:${attachment.id}`);
  } catch {
    return null;
  }
}

function attachmentChunks(attachment: Attachment): string[] {
  if (!attachment.chunksCiphertext) return [];
  try {
    const parsed = JSON.parse(
      decryptString(attachment.chunksCiphertext, `attachment-chunks:${attachment.id}`)
    ) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface PublicAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  hasText: boolean;
  textSkipped: boolean;
  createdAt: string;
}

/**
 * 展示附件列表所需的列。刻意不取 chunksCiphertext：一页 60 条消息可能带几十个附件，
 * 文档分块密文是最大的两列之一，列表页取它纯属浪费 IO 与解密时间。
 */
export const ATTACHMENT_PUBLIC_SELECT = {
  id: true,
  kind: true,
  mime: true,
  size: true,
  createdAt: true,
  originalNameCiphertext: true,
  extractedTextCiphertext: true
} as const satisfies Prisma.AttachmentSelect;

export type AttachmentSummary = Pick<
  Attachment,
  'id' | 'kind' | 'mime' | 'size' | 'createdAt' | 'originalNameCiphertext' | 'extractedTextCiphertext'
>;

export function publicAttachment(attachment: AttachmentSummary): PublicAttachment {
  return {
    id: attachment.id,
    name: attachmentName(attachment),
    mime: attachment.mime,
    size: attachment.size,
    kind: attachment.kind,
    hasText: !!attachment.extractedTextCiphertext,
    textSkipped: !attachment.extractedTextCiphertext && parseSkippedFor(attachment.mime, attachment.size),
    createdAt: attachment.createdAt.toISOString()
  };
}

export async function getAttachmentForUser(id: string, userId: string): Promise<Attachment> {
  const attachment = await prisma.attachment.findFirst({ where: { id, userId } });
  if (!attachment) throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在');
  return attachment;
}

export async function readAttachmentBuffer(attachment: Attachment): Promise<Buffer> {
  const env = loadEnv();
  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(root, attachment.storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(500, 'STORAGE_ERROR', '文件存储路径异常');
  }
  let encrypted: Buffer;
  try {
    encrypted = await readFile(resolved);
  } catch {
    throw new ApiError(404, 'FILE_MISSING', '文件数据缺失');
  }
  let plain: Buffer;
  try {
    plain = decryptBuffer(encrypted, `file:${attachment.id}`);
  } catch {
    throw new ApiError(500, 'FILE_DECRYPT_FAILED', '文件解密失败，可能已损坏');
  }
  const digest = attachmentDigest(attachment.id, plain);
  if (digest !== attachment.sha256) {
    // 早期入库的记录存的是裸内容摘要：确认确实匹配旧算法就地改写这一条，不做批量迁移。
    if (attachment.sha256 === sha256Hex(plain)) {
      await prisma.attachment.update({ where: { id: attachment.id }, data: { sha256: digest } });
      return plain;
    }
    throw new ApiError(500, 'FILE_INTEGRITY_FAILED', '文件完整性校验失败');
  }
  return plain;
}

export async function unlinkAttachmentFile(attachment: Pick<Attachment, 'storageKey'>): Promise<void> {
  const env = loadEnv();
  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(root, attachment.storageKey);
  if (resolved.startsWith(`${root}${path.sep}`)) {
    await unlink(resolved).catch(() => undefined);
  }
}

export async function deleteAttachmentAndFile(
  attachment: Pick<Attachment, 'id' | 'storageKey'>
): Promise<void> {
  await prisma.attachment.delete({ where: { id: attachment.id } }).catch(() => undefined);
  await unlinkAttachmentFile(attachment);
}

export async function getAttachmentsForUser(
  ids: string[],
  userId: string,
  chatId: string
): Promise<Attachment[]> {
  if (!ids.length) return [];
  const rows = await prisma.attachment.findMany({
    where: { id: { in: ids }, userId, chatId }
  });
  if (rows.length !== new Set(ids).size) {
    throw new ApiError(400, 'INVALID_ATTACHMENT', '附件不存在或不属于当前会话');
  }
  for (const row of rows) {
    if (row.messageId) throw new ApiError(400, 'ATTACHMENT_ALREADY_USED', '附件已被使用');
  }
  return rows;
}

/** Picks relevant chunks using a simple lexical score; bounded for token safety. */
export function buildAttachmentContext(
  attachments: Attachment[],
  query: string,
  budgetChars = 12_000
): string {
  if (!attachments.length) return '';
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2)
        .slice(0, 30)
    )
  );
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== 'FILE') continue;
    const name = attachmentName(attachment);
    const chunks = attachmentChunks(attachment);
    if (!chunks.length) {
      const text = attachmentText(attachment);
      if (text) blocks.push(`[文件：${name}]\n${text.slice(0, 4000)}`);
      continue;
    }
    const scored = chunks.map((chunk, index) => {
      const lower = chunk.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      return { chunk, index, score };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = scored.slice(0, 4).sort((a, b) => a.index - b.index);
    let content = selected.map((s) => s.chunk).join('\n…\n');
    if (content.length > 6000) content = content.slice(0, 6000);
    blocks.push(`[文件：${name}]\n${content}`);
  }
  let out = '';
  for (const block of blocks) {
    if (out.length + block.length + 2 > budgetChars) break;
    out += (out ? '\n\n' : '') + block;
  }
  return out;
}

export async function imageDataUrls(attachments: Attachment[]): Promise<string[]> {
  // 多图消息原本串行读盘+解密，第一张照片发出去之前要多等前面每一张的时间。
  return Promise.all(
    selectableImages(attachments).map(async (attachment) => {
      const buffer = await readAttachmentBuffer(attachment);
      return `data:${attachment.mime};base64,${buffer.toString('base64')}`;
    })
  );
}
