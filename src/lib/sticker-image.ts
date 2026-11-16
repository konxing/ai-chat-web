import { ApiError } from './http';

const MAX_SIDE = 1280;
const MAX_FRAMES = 300;
const MAX_ANIMATED_PIXELS = 120_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

type ImageSize = { width: number; height: number; frames: number };

function pngSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return;
  let frames = 1;
  let animationFrames: number | undefined;
  let image = false;
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const end = pos + length + 12;
    if (end > bytes.length) return;
    if (type === 'acTL') {
      if (image || length !== 8 || animationFrames !== undefined) return;
      frames = bytes.readUInt32BE(pos + 8);
      animationFrames = 0;
    }
    if (type === 'fcTL') {
      if (length !== 26 || animationFrames === undefined) return;
      animationFrames++;
    }
    if (type === 'IDAT') image = true;
    if (type === 'IEND') {
      if (!image || length !== 0 || end !== bytes.length ||
          (animationFrames !== undefined && animationFrames !== frames)) return;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), frames };
    }
    pos = end;
  }
}

function skipGifBlocks(bytes: Buffer, pos: number): number {
  while (pos < bytes.length) {
    const size = bytes[pos++];
    if (size === 0) return pos;
    pos += size;
  }
  return bytes.length;
}

function gifSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 14) return;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  let pos = 13 + gifColorTableBytes(bytes[10]);
  let frames = 0;
  while (pos < bytes.length) {
    const kind = bytes[pos++];
    if (kind === 0x3b && frames > 0 && pos === bytes.length) return { width, height, frames };
    if (kind === 0x21) {
      pos = skipGifBlocks(bytes, pos + 1);
      continue;
    }
    if (kind !== 0x2c || pos + 10 > bytes.length) return;
    const frameWidth = bytes.readUInt16LE(pos + 4);
    const frameHeight = bytes.readUInt16LE(pos + 6);
    if (!frameWidth || !frameHeight || bytes.readUInt16LE(pos) + frameWidth > width || bytes.readUInt16LE(pos + 2) + frameHeight > height) return;
    frames++;
    pos = skipGifBlocks(bytes, pos + 10 + gifColorTableBytes(bytes[pos + 8]));
  }
}

function gifColorTableBytes(flags: number) {
  return flags & 0x80 ? 3 * (2 << (flags & 7)) : 0;
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 12 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  for (let pos = 2; pos + 4 < bytes.length;) {
    if (bytes[pos++] !== 0xff) return;
    while (bytes[pos] === 0xff) pos++;
    if (pos + 3 >= bytes.length) return;
    const marker = bytes[pos++];
    if (marker === 0xda || marker === 0xd9) return;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) return;
    if (JPEG_SIZE_MARKERS.has(marker) && length >= 8) {
      return { width: bytes.readUInt16BE(pos + 5), height: bytes.readUInt16BE(pos + 3), frames: 1 };
    }
    pos += length;
  }
}

function webpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WEBP') return;
  let size: ImageSize | undefined;
  let frames = 0;
  let image = false;
  let pos = 12;
  for (; pos + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', pos, pos + 4);
    const length = bytes.readUInt32LE(pos + 4);
    const data = pos + 8;
    const end = data + length + (length % 2);
    if (end > bytes.length) return;
    if (kind === 'VP8X' && length === 10) {
      size = { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1, frames: 1 };
    } else if (kind === 'VP8 ' && length >= 10 && bytes.readUIntBE(data + 3, 3) === 0x9d012a) {
      size ??= { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff, frames: 1 };
      image = true;
    } else if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
      const bits = bytes.readUInt32LE(data + 1);
      size ??= { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, frames: 1 };
      image = true;
    } else if (kind === 'ANMF' && length >= 24 && size) {
      const x = bytes.readUIntLE(data, 3) * 2;
      const y = bytes.readUIntLE(data + 3, 3) * 2;
      if (x + bytes.readUIntLE(data + 6, 3) + 1 > size.width ||
          y + bytes.readUIntLE(data + 9, 3) + 1 > size.height) return;
      frames++;
    }
    pos = end;
  }
  if (size && pos === bytes.length && (image || frames)) return { ...size, frames: frames || 1 };
}

export const PERSONAL_STICKER_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type PersonalStickerMime = (typeof PERSONAL_STICKER_MIMES)[number];

export function stickerImageMime(bytes: Buffer): PersonalStickerMime {
  const gifSignature = bytes.toString('ascii', 0, 6);
  let mime: PersonalStickerMime;
  let size: ImageSize | undefined;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    mime = 'image/png';
    size = pngSize(bytes);
  } else if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') {
    mime = 'image/gif';
    size = gifSize(bytes);
  } else if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) {
    mime = 'image/jpeg';
    size = jpegSize(bytes);
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF') {
    mime = 'image/webp';
    size = webpSize(bytes);
  } else {
    throw new ApiError(415, 'STICKER_FORMAT', '仅支持 PNG、JPEG、GIF 和 WebP 图片');
  }
  if (!size?.width || !size.height || !size.frames) {
    throw new ApiError(400, 'STICKER_INVALID_IMAGE', '图片损坏或格式不完整');
  }
  if (Math.max(size.width, size.height) > MAX_SIDE || size.frames > MAX_FRAMES ||
      size.width * size.height * size.frames > MAX_ANIMATED_PIXELS) {
    throw new ApiError(413, 'STICKER_IMAGE_LIMIT', '图片尺寸或动画帧数过大');
  }
  return mime;
}
