import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_LENGTH = 6;
const CODE_SPACE = 10 ** CODE_LENGTH;

/** Uniformly random, zero-padded numeric code. */
export const generateVerificationCode = (): string =>
  randomInt(0, CODE_SPACE).toString().padStart(CODE_LENGTH, '0');

/**
 * HMAC of the code bound to its recipient, so a leaked row cannot be replayed
 * against another address and the database never holds a usable code.
 */
export const hashVerificationCode = (
  secret: string,
  email: string,
  code: string,
): string =>
  createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');

/** Constant-time comparison of two hex digests. */
export const codesMatch = (
  expectedHash: string,
  actualHash: string,
): boolean => {
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');

  if (expected.length === 0 || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
};
