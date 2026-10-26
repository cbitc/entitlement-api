import { z } from 'zod';

/** Normalised once here, so every layer below sees the same canonical address. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

export const loginCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'The login code must be 6 digits');

export const requestLoginSchema = z.object({ email: emailSchema });

export const verifyLoginSchema = z.object({
  email: emailSchema,
  code: loginCodeSchema,
});

export type RequestLoginInput = z.output<typeof requestLoginSchema>;
export type VerifyLoginInput = z.output<typeof verifyLoginSchema>;
