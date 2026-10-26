import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { IS_PUBLIC_KEY } from '../common/auth/public.decorator';
import { AppException } from '../common/errors/app.exception';
import { AppConfig } from '../config/app-config.service';
import { UsersService } from '../users/users.service';
import type { SessionClaims } from './session-token.service';

/**
 * Authenticates every request unless the route is marked `@Public`.
 *
 * The token proves who signed in; the account is then re-read so a disabled or
 * deleted account loses access immediately instead of at token expiry.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw AppException.unauthorized('A bearer token is required');
    }

    let claims: SessionClaims | undefined;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });
    } catch {
      throw AppException.unauthorized('Invalid or expired token');
    }

    const user = claims?.sub
      ? await this.users.findActiveById(claims.sub)
      : null;
    if (!user) {
      throw AppException.unauthorized('Invalid or expired token');
    }

    request.user = { id: user.id, email: user.email, role: user.role };
    return true;
  }
}

const extractBearerToken = (header: string | undefined): string | null => {
  const [scheme, token] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token;
};
