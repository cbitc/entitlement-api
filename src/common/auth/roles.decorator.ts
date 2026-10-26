import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route to the given roles; checked after authentication. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
