import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppException } from '../errors/app.exception';
import type { AuthenticatedUser } from './authenticated-user';

/**
 * Injects the caller resolved by `JwtAuthGuard`.
 *
 * Reaching a handler without a principal means the route was marked `@Public`
 * by mistake, so it fails loudly instead of running with an undefined user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();

    if (!request.user) {
      throw AppException.unauthorized();
    }
    return request.user;
  },
);
