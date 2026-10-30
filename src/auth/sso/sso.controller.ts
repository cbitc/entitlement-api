import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ZodBody, ZodQuery } from '../../common/http/zod.decorators';
import { AppConfig } from '../../config/app-config.service';
import {
  ssoCallbackSchema,
  ssoExchangeSchema,
  ssoStartSchema,
  type SsoCallbackInput,
  type SsoExchangeInput,
  type SsoStartInput,
} from './sso.schemas';
import { SsoService } from './sso.service';
import { SSO_STATE_COOKIE, ssoStateCookieOptions } from './sso-state.service';

/** A login attempt is a browser navigation, not a hot API: keep it tight. */
const SSO_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * The OIDC relying-party endpoints.
 *
 * `start` and `callback` are browser redirects; `exchange` is the only one the
 * SPA calls with fetch. None of them accepts the session token, so all three
 * are `@Public` — the security comes from the signed state and the one-time
 * ticket.
 */
@ApiTags('auth')
@Controller('auth/sso')
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(
    private readonly sso: SsoService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(SSO_THROTTLE)
  @Get('start')
  @ApiOperation({
    summary: 'Start an SSO login and redirect to the identity provider',
  })
  @ApiFoundResponse({ description: 'Redirect to the identity provider' })
  async start(
    @ZodQuery(ssoStartSchema) query: SsoStartInput,
    @Res() response: Response,
  ): Promise<void> {
    const { url, state } = await this.sso.start(query.returnTo);
    response.cookie(
      SSO_STATE_COOKIE,
      state,
      ssoStateCookieOptions(this.config.isProduction),
    );
    response.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Throttle(SSO_THROTTLE)
  @Get('callback')
  @ApiOperation({
    summary: 'Finish an SSO login and redirect back to the portal',
  })
  @ApiFoundResponse({
    description: 'Redirect to the portal with a one-time ticket',
  })
  async callback(
    @ZodQuery(ssoCallbackSchema) query: SsoCallbackInput,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Read before clearing: the cookie is the proof that this browser started
    // the attempt the IdP is completing.
    const cookieState = readCookie(request.headers.cookie, SSO_STATE_COOKIE);
    response.clearCookie(
      SSO_STATE_COOKIE,
      ssoStateCookieOptions(this.config.isProduction),
    );

    if (query.error) {
      this.redirectToLogin(response, query.error);
      return;
    }
    if (!query.code || !query.state) {
      this.redirectToLogin(response, 'InvalidSsoRequest');
      return;
    }

    try {
      const { ticket, returnTo } = await this.sso.complete({
        code: query.code,
        state: query.state,
        cookieState,
      });

      const target = new URL('/auth/callback', this.config.webAppUrl);
      target.searchParams.set('ticket', ticket);
      target.searchParams.set('next', returnTo);
      response.redirect(HttpStatus.FOUND, target.toString());
    } catch (error) {
      const type = error instanceof AppException ? error.type : 'SsoFailed';
      if (type === 'SsoFailed') {
        this.logger.error({ err: error }, 'Unexpected SSO callback failure');
      }
      this.redirectToLogin(response, type);
    }
  }

  @Public()
  @Throttle(SSO_THROTTLE)
  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a one-time ticket for a session token' })
  @ApiOkResponse({ description: 'A signed session token' })
  exchange(@ZodBody(ssoExchangeSchema) body: SsoExchangeInput) {
    return this.sso.exchange(body.ticket);
  }

  private redirectToLogin(response: Response, error: string): void {
    const target = new URL('/login', this.config.webAppUrl);
    target.searchParams.set('error', error);
    response.redirect(HttpStatus.FOUND, target.toString());
  }
}

/**
 * Minimal Cookie header reader.
 *
 * The state cookie is the only cookie this API reads, so pulling in
 * `cookie-parser` for it would add a dependency and a global middleware for
 * one lookup.
 */
const readCookie = (
  header: string | undefined,
  name: string,
): string | null => {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
};
