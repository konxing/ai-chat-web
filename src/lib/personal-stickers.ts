import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { encryptBuffer, decryptBuffer, encryptString, decryptString } from './crypto';
import { ApiError } from './http';
import {
  isPersonalStickerId,
  PERSONAL_STICKER_LABEL_LIMIT,
  PERSONAL_STICKER_MAX_BYTES,
  PERSONAL_STICKER_MAX_ITEMS,
  PERSONAL_STICKER_TOTAL_BYTES,
  stickerCiphertextContext,
  type PersonalStickerDto
} from './chat-stickers';
import { PERSONAL_STICKER_MIMES, stickerImageMime, type PersonalStickerMime } from './sticker-image';

const STICKER_SUMMARY_SELECT = {
  id: true, userId: true, labelCiphertext: true, size: true, enabled: true
} satisfies Prisma.PersonalStickerSelect;

type StickerSummary = Prisma.PersonalStickerGetPayload<{ select: typeof STICKER_SUMMARY_SELECT }>;

function notFound() {
  return new ApiError(404, 'STICKER_NOT_FOUND', '表情包不存在');
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function publicSticker(row: StickerSummary): PersonalStickerDto | null {
  if (!isPersonalStickerId(row.id)) return null;
  try {
    const label = decryptString(row.labelCiphertext, stickerCiphertextContext('label', row.userId, row.id));
    return { id: row.id, label, size: row.size, enabled: row.enabled };
  } catch {
    return { id: row.id, label: '无法读取标签', size: row.size, enabled: row.enabled };
  }
}

export function parseStickerLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length > PERSONAL_STICKER_LABEL_LIMIT * 2) {
    throw new ApiError(400, 'STICKER_LABEL', `请填写 1–${PERSONAL_STICKER_LABEL_LIMIT} 个字符的表情标签`);
  }
  const label = value.normalize('NFC').trim();
  if (!label || [...label].length > PERSONAL_STICKER_LABEL_LIMIT ||
      !/^[\p{L}\p{M}\p{N}\p{S}\p{Zs}、，。！？,.!?'’_-]+$/u.test(label) || !/[\p{L}\p{N}\p{S}]/u.test(label)) {
    throw new ApiError(400, 'STICKER_LABEL', `请填写 1–${PERSONAL_STICKER_LABEL_LIMIT} 个字符的表情标签`);
  }
  return label;
}

export async function listPersonalStickers(userId: string, enabledOnly = false): Promise<PersonalStickerDto[]> {
  const rows = await prisma.personalSticker.findMany({
    where: { userId, ...(enabledOnly ? { enabled: true } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PERSONAL_STICKER_MAX_ITEMS,
    select: STICKER_SUMMARY_SELECT
  });
  return rows.map(publicSticker).filter((row) => row !== null);
}

export async function importPersonalSticker(userId: string, label: string, bytes: Buffer): Promise<PersonalStickerDto> {
  if (bytes.length > PERSONAL_STICKER_MAX_BYTES) throw new ApiError(413, 'STICKER_FILE_LIMIT', '每张表情包最多 3 MB');
  const mime = stickerImageMime(bytes);
  const id = `u${randomUUID().replaceAll('-', '')}` as const;
  const digest = createHash('sha256').update(userId).update('\0').update(bytes).digest('hex');
  const labelCiphertext = encryptString(label, stickerCiphertextContext('label', userId, id));
  const imageCiphertext = new Uint8Array(encryptBuffer(bytes, stickerCiphertextContext('image', userId, id)));

  // Serializable keeps the per-account count and byte quota valid across concurrently running processes.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const usage = await tx.personalSticker.aggregate({
          where: { userId }, _count: { _all: true }, _sum: { size: true }
        });
        if (usage._count._all >= PERSONAL_STICKER_MAX_ITEMS || (usage._sum.size ?? 0) + bytes.length > PERSONAL_STICKER_TOTAL_BYTES) {
          throw new ApiError(409, 'STICKER_LIBRARY_FULL', '个人表情库已满，请删除不再需要的表情包');
        }
        await tx.personalSticker.create({
          data: { id, userId, labelCiphertext, imageCiphertext, mime, size: bytes.length, digest },
          select: { id: true }
        });
      }, { isolationLevel: 'Serializable' });
      return { id, label, size: bytes.length, enabled: true };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'P2002') throw new ApiError(409, 'STICKER_ALREADY_EXISTS', '这张表情包已经在你的库里');
      if (code !== 'P2034') throw error;
    }
  }
  throw new ApiError(409, 'STICKER_LIBRARY_BUSY', '表情库正在更新，请稍后重试');
}

export async function readPersonalSticker(userId: string, id: string) {
  if (!isPersonalStickerId(id)) throw notFound();
  const row = await prisma.personalSticker.findFirst({
    where: { id, userId }, select: { mime: true, imageCiphertext: true }
  });
  if (!row || !PERSONAL_STICKER_MIMES.includes(row.mime as PersonalStickerMime)) throw notFound();
  return {
    mime: row.mime,
    bytes: decryptBuffer(Buffer.from(row.imageCiphertext), stickerCiphertextContext('image', userId, id))
  };
}

export async function updatePersonalSticker(userId: string, id: string, patch: { enabled?: boolean; label?: string }) {
  if (!isPersonalStickerId(id)) throw notFound();
  try {
    const row = await prisma.personalSticker.update({
      where: { id, userId },
      data: {
        enabled: patch.enabled,
        labelCiphertext: patch.label === undefined
          ? undefined
          : encryptString(patch.label, stickerCiphertextContext('label', userId, id))
      },
      select: STICKER_SUMMARY_SELECT
    });
    return publicSticker(row);
  } catch (error) {
    if (errorCode(error) === 'P2025') throw notFound();
    throw error;
  }
}

export async function deletePersonalSticker(userId: string, id: string) {
  if (!isPersonalStickerId(id)) throw notFound();
  const deleted = await prisma.personalSticker.deleteMany({ where: { id, userId } });
  if (!deleted.count) throw notFound();
}
