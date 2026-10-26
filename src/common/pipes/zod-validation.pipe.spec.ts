import type { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppException } from '../errors/app.exception';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  email: z.email(),
  code: z.string().length(6),
});

const metadata: ArgumentMetadata = { type: 'body' };

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value and strips unknown keys', () => {
    const result = pipe.transform(
      { email: 'buyer@example.com', code: '123456', extra: 'dropped' },
      metadata,
    );

    expect(result).toEqual({ email: 'buyer@example.com', code: '123456' });
  });

  it('throws a ValidationError naming the offending field', () => {
    expect(() =>
      pipe.transform({ email: 'nope', code: '1' }, metadata),
    ).toThrow(AppException);

    try {
      pipe.transform({ email: 'nope', code: '1' }, metadata);
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const appError = error as AppException;
      expect(appError.type).toBe('ValidationError');
      expect(appError.status).toBe(400);
      expect(appError.message).toMatch(/email/);
    }
  });
});
