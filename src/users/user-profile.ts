import type { User, UserRole, UserStatus } from '@prisma/client';

/** The account as the API exposes it: no secrets, dates as ISO strings. */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly emailVerifiedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

export const toUserProfile = (user: User): UserProfile => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
  emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});
