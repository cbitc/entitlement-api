import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { ROLES_KEY } from '../common/auth/roles.decorator';
import { AppException } from '../common/errors/app.exception';

/**
 * Enforces `@Roles(...)`. Runs after {@link JwtAuthGuard}, which is what puts
 * the principal on the request; a route with no `@Roles` is open to any
 * authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();

    if (!request.user || !roles.includes(request.user.role)) {
      throw AppException.forbidden('Insufficient permissions');
    }
    return true;
  }
}
