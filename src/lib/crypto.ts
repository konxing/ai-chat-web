import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { loadEnv } from './env';

const STRING_PREFIX = 'enc:v2';
const FILE_MAGIC = Buffer.from('FAC2', 'ascii');
const LEGACY_FILE_MAGIC = Buffer.from('FAC1', 'ascii');

/**
 * v2 使用 ChaCha20-Poly1305（RFC 8439），采用 256 位密钥、96 位随机 nonce 和 128 位 tag。
 * v1（AES-256-GCM / FAC1）仅保留**解密**兼容，新写入一律 v2。
 */
// 分支用字面量算法名，命中 Node 的 AEAD 重载（联合类型会落到通用 Transform 重载）。
function newCipher(key: Buffer, iv: Buffer, legacy: boolean) {
  return legacy
    ? createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    : createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
}
function newDecipher(key: Buffer, iv: Buffer, legacy: boolean) {
  return legacy
    ? createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    : createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function keyFor(id: string): Buffer {
  const env = loadEnv();
  const key = env.masterKeys.get(id);
  if (!key) throw new Error(`Unknown encryption key id: ${id}`);
  return key;
}

export function currentKeyId(): string {
  return loadEnv().MASTER_KEY_ID;
}

export function encryptString(plaintext: string, aad = ''): string {
  const keyId = currentKeyId();
  const iv = randomBytes(12);
  const cipher = newCipher(keyFor(keyId), iv, false);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = cipher.update(plaintext, 'utf8');
  const tail = cipher.final();
  const ciphertext = tail.length ? Buffer.concat([body, tail]) : body;
  const tag = cipher.getAuthTag();
  return [STRING_PREFIX, keyId, b64url(iv), b64url(tag), b64url(ciphertext)].join(':');
}

export function decryptString(payload: string, aad = ''): string {
  const parts = payload.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || (parts[1] !== 'v1' && parts[1] !== 'v2')) {
    throw new Error('Unsupported ciphertext format');
  }
  const [, version, keyId, ivB64, tagB64, ctB64] = parts;
  const iv = fromB64url(ivB64);
  const tag = fromB64url(tagB64);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid ciphertext parameters');
  const decipher = newDecipher(keyFor(keyId), iv, version === 'v1');
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const body = decipher.update(fromB64url(ctB64));
  const tail = decipher.final();
  return (tail.length ? Buffer.concat([body, tail]) : body).toString('utf8');
}

/** Returns the key id stored in a ciphertext, without decrypting it. */
export function cipherKeyId(payload: string): string | null {
  const parts = payload.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || (parts[1] !== 'v1' && parts[1] !== 'v2')) return null;
  return parts[2];
}

export function encryptBuffer(plaintext: Buffer, aad = ''): Buffer {
  const keyId = currentKeyId();
  const keyIdBuf = Buffer.from(keyId, 'utf8');
  if (keyIdBuf.length > 16) throw new Error('Key id too long');
  const iv = randomBytes(12);
  const cipher = newCipher(keyFor(keyId), iv, false);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = cipher.update(plaintext);
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    FILE_MAGIC,
    Buffer.from([keyIdBuf.length]),
    keyIdBuf,
    iv,
    tag,
    ciphertext,
    tail
  ]);
}

export function decryptBuffer(payload: Buffer, aad = ''): Buffer {
  if (payload.length < 4 + 1 + 12 + 16) throw new Error('Invalid encrypted file');
  const isLegacy = payload.subarray(0, 4).equals(LEGACY_FILE_MAGIC);
  if (!isLegacy && !payload.subarray(0, 4).equals(FILE_MAGIC)) throw new Error('Invalid file magic');
  const keyIdLen = payload[4];
  if (keyIdLen < 1 || keyIdLen > 16) throw new Error('Invalid key id length');
  let offset = 5;
  if (payload.length < offset + keyIdLen + 12 + 16) throw new Error('Truncated encrypted file');
  const keyId = payload.subarray(offset, offset + keyIdLen).toString('utf8');
  offset += keyIdLen;
  const iv = payload.subarray(offset, offset + 12);
  offset += 12;
  const tag = payload.subarray(offset, offset + 16);
  offset += 16;
  const decipher = newDecipher(keyFor(keyId), iv, isLegacy);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const body = decipher.update(payload.subarray(offset));
  const tail = decipher.final(); // Authenticate before returning any plaintext.
  return tail.length ? Buffer.concat([body, tail]) : body;
}

/** `cipherKeyId` 的 Bytes 版：只读包头的 keyId，不解密。格式不对返回 null。 */
export function bufferKeyId(payload: Buffer): string | null {
  if (!Buffer.isBuffer(payload) || payload.length < 5 + 1 + 12 + 16) return null;
  if (!payload.subarray(0, 4).equals(FILE_MAGIC) && !payload.subarray(0, 4).equals(LEGACY_FILE_MAGIC)) return null;
  const keyIdLen = payload[4];
  if (keyIdLen < 1 || keyIdLen > 16) return null;
  if (payload.length < 5 + keyIdLen + 12 + 16) return null;
  return payload.subarray(5, 5 + keyIdLen).toString('utf8');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(secret: Buffer | string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
