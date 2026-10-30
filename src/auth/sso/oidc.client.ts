import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config.service';

/** The subset of the discovery document this relying party actually uses. */
interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface AuthorizeUrlInput {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

/** The claims this API trusts after verifying the signature and the nonce. */
export interface IdTokenClaims {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

interface TokenResponse {
  readonly id_token?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

/**
 * The only component that speaks OIDC to the identity provider.
 *
 * It is deliberately a thin protocol adapter: no account, no session, no
 * database. Discovery and the JWKS are cached lazily, so a cold start costs
 * two round trips and every later login costs one (the token exchange).
 */
@Injectable()
export class OidcClient {
  private readonly logger = new Logger(OidcClient.name);
  private discovery?: Promise<DiscoveryDocument>;
  private jwks?: JWTVerifyGetKey;

  constructor(private readonly config: AppConfig) {}

  /** Authorization Code + PKCE URL the browser is sent to. */
  async authorizationUrl(input: AuthorizeUrlInput): Promise<string> {
    const discovery = await this.discover();
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.sso.clientId);
    url.searchParams.set('redirect_uri', this.sso.redirectUri);
    url.searchParams.set('scope', this.sso.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Trades the authorization code for an id_token and returns the raw token. */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.sso.redirectUri,
      client_id: this.sso.clientId,
      code_verifier: codeVerifier,
    });
    if (this.sso.clientSecret.length > 0) {
      body.set('client_secret', this.sso.clientSecret);
    }

    const response = await this.request(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    let payload: TokenResponse;
    try {
      payload = (await response.json()) as TokenResponse;
    } catch {
      throw new AppException(
        'SsoTokenExchangeFailed',
        HttpStatus.BAD_GATEWAY,
        'The identity provider returned an unreadable token response',
      );
    }

    if (!response.ok || typeof payload.id_token !== 'string') {
      this.logger.warn(
        {
          status: response.status,
          error: payload.error,
          description: payload.error_description,
        },
        'Token exchange was rejected by the identity provider',
      );
      throw new AppException(
        'SsoTokenExchangeFailed',
        HttpStatus.BAD_GATEWAY,
        'The identity provider rejected the authorization code',
      );
    }
    return payload.id_token;
  }

  /**
   * Verifies the id_token and returns only the claims the product needs.
   *
   * `nonce` is compared against the value this API generated for the same
   * browser journey, which is what stops a token minted for another login from
   * being replayed here.
   */
  async verifyIdToken(idToken: string, nonce: string): Promise<IdTokenClaims> {
    const discovery = await this.discover();
    const jwks = (this.jwks ??= createRemoteJWKSet(
      new URL(discovery.jwks_uri),
      {
        timeoutDuration: this.sso.httpTimeoutMs,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      },
    ));

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: this.sso.issuer,
        audience: this.sso.clientId,
        clockTolerance: 60,
      }));
    } catch (error) {
      this.logger.warn({ err: error }, 'id_token verification failed');
      throw new AppException(
        'SsoTokenInvalid',
        HttpStatus.UNAUTHORIZED,
        'The identity provider returned an invalid token',
      );
    }

    if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
      throw new AppException(
        'SsoTokenInvalid',
        HttpStatus.UNAUTHORIZED,
        'The identity token does not belong to this login attempt',
      );
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new AppException(
        'SsoTokenInvalid',
        HttpStatus.UNAUTHORIZED,
        'The identity token has no subject',
      );
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : '';
    if (email.length === 0) {
      throw new AppException(
        'SsoEmailMissing',
        HttpStatus.UNAUTHORIZED,
        'The identity provider did not supply an email address',
      );
    }

    return {
      subject,
      email,
      // Some providers send the string "true"; treat everything else as no.
      emailVerified:
        payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }

  private get sso(): AppConfig['sso'] {
    return this.config.sso;
  }

  private async discover(): Promise<DiscoveryDocument> {
    // Cache the promise, not the result: concurrent cold-start logins share one
    // discovery request. A failed promise is dropped so the next login retries.
    this.discovery ??= this.fetchDiscovery().catch((error: unknown) => {
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<DiscoveryDocument> {
    const url = `${this.sso.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await this.request(url, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new AppException(
        'SsoDiscoveryInvalid',
        HttpStatus.BAD_GATEWAY,
        `The identity provider rejected the discovery request (${response.status})`,
      );
    }

    const document = (await response.json().catch(() => null)) as Partial<
      Record<keyof DiscoveryDocument, unknown>
    > | null;
    if (!document) {
      throw new AppException(
        'SsoDiscoveryInvalid',
        HttpStatus.BAD_GATEWAY,
        'The identity provider returned an unreadable discovery document',
      );
    }
    if (document.issuer !== this.sso.issuer) {
      this.logger.warn(
        { expected: this.sso.issuer, actual: document.issuer },
        'Discovery document issuer does not match SSO_ISSUER',
      );
      throw new AppException(
        'SsoDiscoveryInvalid',
        HttpStatus.BAD_GATEWAY,
        'The identity provider discovery document does not match SSO_ISSUER',
      );
    }
    for (const key of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
    ] as const) {
      if (typeof document[key] !== 'string') {
        throw new AppException(
          'SsoDiscoveryInvalid',
          HttpStatus.BAD_GATEWAY,
          `The identity provider discovery document is missing ${key}`,
        );
      }
    }
    return document as unknown as DiscoveryDocument;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.sso.httpTimeoutMs),
      });
    } catch (error) {
      this.logger.warn({ err: error, url }, 'Identity provider is unreachable');
      throw new AppException(
        'SsoUnavailable',
        HttpStatus.BAD_GATEWAY,
        'The identity provider is unavailable, please retry later',
      );
    }
  }
}
