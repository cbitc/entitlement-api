import type { UserRole } from '@prisma/client';

/**
 * The authenticated principal attached to a request by the global auth guard.
 *
 * Shared so feature modules (users, and later subscription/licensing) can read
 * the caller without importing the auth module itself.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}
