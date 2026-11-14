import { beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  bufferKeyId,
  cipherKeyId,
  currentKeyId,
  decryptBuffer,
  decryptString,
  encryptBuffer,
  encryptString,
  hmacHex,
  randomToken,
  safeEqualHex,
  sha256Hex
} from '@/lib/crypto';
import { resetEnvCacheForTests } from '@/lib/env';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');

function useKeys(primaryId: string, primaryKey: string, ring: Record<string, string> = {}) {
  process.env.MASTER_KEY_ID = primaryId;
  process.env.MASTER_KEY = primaryKey;
  process.env.MASTER_KEYRING = JSON.stringify(ring);
  resetEnvCacheForTests();
}

beforeEach(() => {
  useKeys('ka', keyA);
});

describe('ChaCha20-Poly1305 (v2) string encryption', () => {
  it('round-trips Unicode plaintext with AAD', () => {
    const ciphertext = encryptString('私人聊天 · secret 🔐', 'message:abc');
    expect(ciphertext.startsWith('enc:v2:ka:')).toBe(true);
    expect(ciphertext).not.toContain('私人聊天');
    expect(cipherKeyId(ciphertext)).toBe('ka');
    expect(decryptString(ciphertext, 'message:abc')).toBe('私人聊天 · secret 🔐');
  });

  it('uses a fresh IV for every encryption', () => {
    const a = encryptString('same', 'aad');
    const b = encryptString('same', 'aad');
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext, IV, tag and AAD', () => {
    const payload = encryptString('top secret', 'message:abc');
    const parts = payload.split(':');
    const tamperedCipher = [...parts];
    tamperedCipher[5] = Buffer.from('different').toString('base64url');
    expect(() => decryptString(tamperedCipher.join(':'), 'message:abc')).toThrow();

    const tamperedTag = [...parts];
    tamperedTag[4] = Buffer.alloc(16, 9).toString('base64url');
    expect(() => decryptString(tamperedTag.join(':'), 'message:abc')).toThrow();

    expect(() => decryptString(payload, 'message:other')).toThrow();
    expect(() => decryptString('enc:v9:ka:a:b:c')).toThrow();
  });

  it('decrypts data encrypted under an old key kept in the keyring', () => {
    const oldPayload = encryptString('legacy value', 'chat-title:1');
    useKeys('kb', keyB, { ka: keyA });
    expect(currentKeyId()).toBe('kb');
    expect(decryptString(oldPayload, 'chat-title:1')).toBe('legacy value');
    expect(decryptString(encryptString('new value', 'chat-title:2'), 'chat-title:2')).toBe('new value');
  });

  it('fails when the key id is unknown', () => {
    useKeys('kb', keyB);
    const payload = encryptString('value', '');
    useKeys('kc', keyB);
    expect(() => decryptString(payload, '')).toThrow();
  });
});

describe('encrypted binary files (FAC2)', () => {
  it('round-trips binary data with AAD and records the key id', () => {
    const plain = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const encrypted = encryptBuffer(plain, 'file:one');
    expect(encrypted.subarray(0, 4).toString('ascii')).toBe('FAC2');
    expect(encrypted[4]).toBe(2);
    expect(encrypted.subarray(5, 7).toString('utf8')).toBe('ka');
    expect(encrypted.includes(plain)).toBe(false);
    expect(decryptBuffer(encrypted, 'file:one').equals(plain)).toBe(true);
  });

  it('rejects bad magic, truncation, tampering and wrong AAD', () => {
    const encrypted = encryptBuffer(Buffer.from('hello'), 'file:one');
    const badMagic = Buffer.from(encrypted);
    badMagic[0] = 0;
    expect(() => decryptBuffer(badMagic, 'file:one')).toThrow();

    expect(() => decryptBuffer(encrypted.subarray(0, 20), 'file:one')).toThrow();

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptBuffer(tampered, 'file:one')).toThrow();

    expect(() => decryptBuffer(encrypted, 'file:two')).toThrow();
  });

  it('reads files written under an old key from the keyring', () => {
    const encrypted = encryptBuffer(Buffer.from('old file'), 'file:legacy');
    useKeys('kb', keyB, { ka: keyA });
    expect(decryptBuffer(encrypted, 'file:legacy').toString()).toBe('old file');
  });
});

describe('legacy v1 / FAC1 (AES-256-GCM) read compatibility', () => {
  const b64url = (b: Buffer) => b.toString('base64url');
  const legacyKey = Buffer.alloc(32, 1);

  it('decrypts a v1 string written by the old AES-256-GCM code', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('message:legacy', 'utf8'));
    const ct = Buffer.concat([cipher.update('old secret', 'utf8'), cipher.final()]);
    const payload = ['enc:v1:ka', b64url(iv), b64url(cipher.getAuthTag()), b64url(ct)].join(':');
    expect(cipherKeyId(payload)).toBe('ka');
    expect(decryptString(payload, 'message:legacy')).toBe('old secret');
    expect(() => decryptString(payload, 'message:other')).toThrow();
  });

  it('decrypts a FAC1 buffer written by the old AES-256-GCM code', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('file:legacy', 'utf8'));
    const plain = Buffer.from('old file bytes');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const keyId = Buffer.from('ka', 'utf8');
    const container = Buffer.concat([Buffer.from('FAC1'), Buffer.from([keyId.length]), keyId, iv, cipher.getAuthTag(), ct]);
    expect(bufferKeyId(container)).toBe('ka');
    expect(decryptBuffer(container, 'file:legacy').equals(plain)).toBe(true);
  });
});

describe('hashing and tokens', () => {
  it('computes SHA-256 and HMAC known values', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacHex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    );
  });

  it('compares hex digests in constant time and rejects mismatches', () => {
    const a = sha256Hex('a');
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, sha256Hex('b'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('zz', 'zz')).toBe(false);
  });

  it('generates unpredictable tokens with the requested size', () => {
    const a = randomToken(16);
    const b = randomToken(16);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
  });
});
