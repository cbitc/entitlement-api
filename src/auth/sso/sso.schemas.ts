import { z } from 'zod';

/** `returnTo` is sanitised again in the service; the schema only bounds size. */
export const ssoStartSchema = z.object({
  returnTo: z.string().max(512).optional(),
});

/**
 * The IdP answers either with `code` + `state` or with `error`. Accepting both
 * shapes lets the controller redirect the browser back to the SPA with a
 * readable reason instead of showing it a JSON error envelope.
 */
export const ssoCallbackSchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(4096).optional(),
  error: z.string().max(128).optional(),
});

export const ssoExchangeSchema = z.object({
  ticket: z.string().min(1).max(256),
});

export type SsoStartInput = z.output<typeof ssoStartSchema>;
export type SsoCallbackInput = z.output<typeof ssoCallbackSchema>;
export type SsoExchangeInput = z.output<typeof ssoExchangeSchema>;
