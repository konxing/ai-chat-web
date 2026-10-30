import { beforeEach, describe, expect, it } from 'vitest';
import {
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

describe('AES-256-GCM string encryption', () => {
  it('round-trips Unicode plaintext with AAD', () => {
    const ciphertext = encryptString('家庭聊天 · secret 🔐', 'message:abc');
    expect(ciphertext.startsWith('enc:v1:ka:')).toBe(true);
    expect(ciphertext).not.toContain('家庭聊天');
    expect(cipherKeyId(ciphertext)).toBe('ka');
    expect(decryptString(ciphertext, 'message:abc')).toBe('家庭聊天 · secret 🔐');
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
    expect(() => decryptString('enc:v2:ka:a:b:c')).toThrow();
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

describe('encrypted binary files (FAC1)', () => {
  it('round-trips binary data with AAD and records the key id', () => {
    const plain = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const encrypted = encryptBuffer(plain, 'file:one');
    expect(encrypted.subarray(0, 4).toString('ascii')).toBe('FAC1');
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
