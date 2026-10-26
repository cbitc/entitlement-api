import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:is-public';

/**
 * Opts a route out of the global authentication guard.
 *
 * Authentication is on by default, so forgetting to guard a new endpoint
 * fails closed instead of leaking it.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
