import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config.service';

/** The state token is not a session token: give it its own audience. */
const SSO_STATE_AUDIENCE = 'entitlement-sso-state';

export const SSO_STATE_COOKIE = 'sso_state';
export const SSO_STATE_COOKIE_PATH = '/auth/sso';

/** Everything the callback needs to finish the journey. */
export interface SsoState {
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Already sanitised to a same-site path when the state was issued. */
  readonly returnTo: string;
}

/**
 * Binds one browser to one login attempt.
 *
 * The state is a short-lived signed JWT carried in an HttpOnly cookie *and*
 * echoed by the IdP in the callback query. Comparing the two proves the
 * callback belongs to a login this browser started (login CSRF), while the
 * embedded nonce ties the eventual id_token to the same attempt. The
 * code_verifier travels inside the signed token, so no server-side store is
 * needed and several instances can share the flow.
 */
@Injectable()
export class SsoStateService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async issue(state: SsoState): Promise<string> {
    return this.jwt.signAsync(state, {
      audience: SSO_STATE_AUDIENCE,
      expiresIn: this.config.sso.stateTtlSeconds,
    });
  }

  async verify(token: string): Promise<SsoState> {
    let payload: Partial<SsoState>;
    try {
      payload = await this.jwt.verifyAsync<Partial<SsoState>>(token, {
        issuer: this.config.jwtIssuer,
        audience: SSO_STATE_AUDIENCE,
      });
    } catch {
      throw invalidState();
    }

    const { nonce, codeVerifier, returnTo } = payload;
    if (
      typeof nonce !== 'string' ||
      typeof codeVerifier !== 'string' ||
      typeof returnTo !== 'string'
    ) {
      throw invalidState();
    }
    return { nonce, codeVerifier, returnTo };
  }
}

const invalidState = (): AppException =>
  new AppException(
    'InvalidSsoState',
    HttpStatus.BAD_REQUEST,
    'The login attempt could not be verified, please start again',
  );

/** Cookie options shared by `start` (set) and `callback` (clear). */
export const ssoStateCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  path: SSO_STATE_COOKIE_PATH,
});

/**
 * Keeps `returnTo` a same-site path.
 *
 * Anything absolute, protocol-relative or containing a backslash is dropped:
 * a redirect target that the caller controls is an open redirect.
 */
export const sanitizeReturnTo = (value: string | undefined): string => {
  const candidate = value?.trim() ?? '';
  if (
    candidate.length === 0 ||
    candidate.length > 512 ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  ) {
    return '/';
  }
  return candidate;
};
