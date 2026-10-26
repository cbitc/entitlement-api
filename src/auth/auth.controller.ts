import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/auth/public.decorator';
import { ZodBody } from '../common/http/zod.decorators';
import {
  requestLoginSchema,
  verifyLoginSchema,
  type RequestLoginInput,
  type VerifyLoginInput,
} from './auth.schemas';
import { AuthService } from './auth.service';

/** Brute-force surface: much tighter than the global limit. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('request-login')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a login code to an email address' })
  @ApiAcceptedResponse({
    description: 'The code was handed to the mail transport',
  })
  async requestLogin(@ZodBody(requestLoginSchema) body: RequestLoginInput) {
    const result = await this.auth.requestLogin(body.email);
    return {
      email: result.email,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('verify-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a login code for a session token' })
  @ApiOkResponse({ description: 'A signed session token' })
  verifyLogin(@ZodBody(verifyLoginSchema) body: VerifyLoginInput) {
    return this.auth.verifyLogin(body.email, body.code);
  }
}
