import { describe, expect, it } from 'vitest';
import { hashPassword, isArgon2idHash, passwordPolicyError, verifyPassword } from '@/lib/password';

describe('password policy', () => {
  it('accepts a strong passphrase', () => {
    expect(passwordPolicyError('Blue-Harbor!2026#91', { username: 'mira', email: 'mira@example.com' })).toBeNull();
  });

  it.each([
    ['short', 'Ab1!'],
    ['common', 'password123'],
    ['single category', 'abcdefghijkl'],
    ['username', 'Mira-Secret-2026!'],
    ['email prefix', 'Example-Secret-2026!'],
    ['repeated spaces', 'Blue  Harbor-2026!']
  ])('rejects %s passwords', (_label, password) => {
    expect(
      passwordPolicyError(password, { username: 'mira', email: 'example@example.com' })
    ).not.toBeNull();
  });

  it('rejects overlong and non-string input', () => {
    expect(passwordPolicyError('A1!' + 'x'.repeat(130))).not.toBeNull();
    expect(passwordPolicyError(undefined as unknown as string)).not.toBeNull();
  });
});

describe('Argon2id hashing', () => {
  it('hashes with Argon2id and verifies correctly', async () => {
    const hash = await hashPassword('Blue-Harbor!2026#91');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(isArgon2idHash(hash)).toBe(true);
    expect(hash).not.toContain('Blue-Harbor');
    await expect(verifyPassword(hash, 'Blue-Harbor!2026#91')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('returns false for missing or malformed hashes without throwing', async () => {
    await expect(verifyPassword(null, 'anything')).resolves.toBe(false);
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    expect(isArgon2idHash('$2b$12$abcdef')).toBe(false);
  });

  it('produces different salts for the same password', async () => {
    const a = await hashPassword('Blue-Harbor!2026#91');
    const b = await hashPassword('Blue-Harbor!2026#91');
    expect(a).not.toBe(b);
  });
});
