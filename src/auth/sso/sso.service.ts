import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config.service';
import { Clock } from '../../infra/clock/clock';
import { UsersService } from '../../users/users.service';
import { LoginTicketService } from './login-ticket.service';
import { OidcClient } from './oidc.client';
import { SessionTokenService } from '../session-token.service';
import { sanitizeReturnTo, SsoStateService } from './sso-state.service';

export interface SsoStartResult {
  readonly url: string;
  readonly state: string;
}

export interface SsoCallbackResult {
  readonly ticket: string;
  /** Same-site path the SPA should open after redeeming the ticket. */
  readonly returnTo: string;
}

/**
 * The SSO journey: browser leaves for the IdP, comes back with a code, and the
 * API turns that into a local session.
 *
 * Kept separate from the controller so redirects and cookies stay in the HTTP
 * layer while the security decisions live here.
 */
@Injectable()
export class SsoService {
  constructor(
    private readonly oidc: OidcClient,
    private readonly state: SsoStateService,
    private readonly tickets: LoginTicketService,
    private readonly users: UsersService,
    private readonly tokens: SessionTokenService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async start(returnTo: string | undefined): Promise<SsoStartResult> {
    const nonce = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const state = await this.state.issue({
      nonce,
      codeVerifier,
      returnTo: sanitizeReturnTo(returnTo),
    });
    const url = await this.oidc.authorizationUrl({
      state,
      nonce,
      codeChallenge,
    });

    return { url, state };
  }

  /** Validates the callback and mints a one-time ticket for the SPA. */
  async complete(input: {
    readonly code: string;
    readonly state: string;
    readonly cookieState: string | null;
  }): Promise<SsoCallbackResult> {
    if (!input.cookieState || input.cookieState !== input.state) {
      // The state must come back from the same browser that started the login;
      // without this check an attacker could complete *their* login in the
      // victim's browser (login CSRF).
      throw new AppException(
        'InvalidSsoState',
        HttpStatus.BAD_REQUEST,
        'The login attempt could not be verified, please start again',
      );
    }

    const state = await this.state.verify(input.state);
    const idToken = await this.oidc.exchangeCode(
      input.code,
      state.codeVerifier,
    );
    const claims = await this.oidc.verifyIdToken(idToken, state.nonce);
    this.assertAllowedDomain(claims.email);

    const user = await this.users.upsertFromIdentity(
      {
        provider: 'oidc',
        subject: claims.subject,
        email: claims.email,
        displayName: claims.name,
        emailVerified: claims.emailVerified,
      },
      this.clock.now(),
    );

    const { ticket } = await this.tickets.issue(user.id);
    return { ticket, returnTo: state.returnTo };
  }

  /** Trades the one-time ticket for the session token the API expects. */
  async exchange(ticket: string): Promise<{ token: string }> {
    const userId = await this.tickets.consume(ticket);
    const user = await this.users.findActiveById(userId);
    if (!user) {
      throw AppException.unauthorized('The account is no longer available');
    }
    return { token: await this.tokens.issue(user) };
  }

  private assertAllowedDomain(email: string): void {
    const allowed = this.config.sso.allowedEmailDomains;
    if (allowed.length === 0) {
      return;
    }
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!allowed.includes(domain)) {
      throw new AppException(
        'EmailDomainNotAllowed',
        HttpStatus.FORBIDDEN,
        'This email domain is not allowed to sign in',
      );
    }
  }
}
