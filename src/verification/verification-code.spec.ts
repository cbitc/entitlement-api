import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  codesMatch,
  generateVerificationCode,
  hashVerificationCode,
} from './verification-code';

const SECRET = 'test-only-jwt-secret-with-32-characters';
const EMAIL = 'buyer@example.com';

describe('generateVerificationCode', () => {
  it('produces six digits, including leading zeros', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateVerificationCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashVerificationCode', () => {
  it('is stable for the same secret, address and code', () => {
    expect(hashVerificationCode(SECRET, EMAIL, '123456')).toBe(
      hashVerificationCode(SECRET, EMAIL, '123456'),
    );
    expect(hashVerificationCode(SECRET, EMAIL, '123456')).toHaveLength(64);
  });

  it('binds the code to the recipient and the secret', () => {
    const hash = hashVerificationCode(SECRET, EMAIL, '123456');

    expect(
      hashVerificationCode(SECRET, 'other@example.com', '123456'),
    ).not.toBe(hash);
    expect(hashVerificationCode(`${SECRET}-rotated`, EMAIL, '123456')).not.toBe(
      hash,
    );
  });
});

describe('codesMatch', () => {
  const hash = hashVerificationCode(SECRET, EMAIL, '123456');

  it('accepts the matching digest', () => {
    expect(
      codesMatch(hash, hashVerificationCode(SECRET, EMAIL, '123456')),
    ).toBe(true);
  });

  it('rejects a different code and a malformed digest', () => {
    expect(
      codesMatch(hash, hashVerificationCode(SECRET, EMAIL, '654321')),
    ).toBe(false);
    expect(codesMatch(hash, 'not-hex')).toBe(false);
    expect(codesMatch('', hash)).toBe(false);
  });
});
