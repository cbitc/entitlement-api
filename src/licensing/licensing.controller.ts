import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { Public } from '../common/auth/public.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { ZodBody, ZodQuery } from '../common/http/zod.decorators';
import { LicenseTokenService } from './license-token.service';
import {
  adminLicenseQuerySchema,
  adminRevokeLicenseSchema,
  licenseMachineSchema,
  type AdminLicenseQuery,
  type AdminRevokeLicenseInput,
  type LicenseMachineInput,
} from './licensing.schemas';
import { LicensingService } from './licensing.service';
import type {
  AdminLicenseListResponse,
  LicenseListResponse,
  LicenseTokenView,
} from './licensing.types';

@ApiTags('licensing')
@ApiBearerAuth('session')
@Controller('licensing')
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Post('licenses/obtain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtain or refresh the license token for this machine',
  })
  @ApiOkResponse({ description: 'A signed, short-lived license token' })
  obtain(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(licenseMachineSchema) body: LicenseMachineInput,
  ): Promise<LicenseTokenView> {
    return this.licensing.obtain(current.id, body, false);
  }

  @Post('licenses/offline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtain an offline license token that expires with the period',
  })
  @ApiOkResponse({ description: 'A signed offline license token' })
  offline(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(licenseMachineSchema) body: LicenseMachineInput,
  ): Promise<LicenseTokenView> {
    return this.licensing.obtain(current.id, body, true);
  }

  @Post('licenses/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Release the activation slot held by this machine' })
  @ApiNoContentResponse({ description: 'The device is no longer activated' })
  deactivate(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(licenseMachineSchema) body: LicenseMachineInput,
  ): Promise<void> {
    return this.licensing.deactivate(current.id, body);
  }

  @Get('licenses')
  @ApiOperation({ summary: 'The caller licenses and their activated devices' })
  @ApiOkResponse({ description: 'Licenses, newest subscription first' })
  list(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<LicenseListResponse> {
    return this.licensing.listForUser(current.id);
  }

  @Get('admin/licenses')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List every license of one account (admin)' })
  @ApiOkResponse({ description: 'The account licenses and activations' })
  adminList(
    @ZodQuery(adminLicenseQuerySchema) query: AdminLicenseQuery,
  ): Promise<AdminLicenseListResponse> {
    return this.licensing.adminList(query.email);
  }

  @Delete('admin/licenses')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke the current license and all activations (admin)',
  })
  @ApiNoContentResponse({ description: 'The license was revoked' })
  async adminRevoke(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(adminRevokeLicenseSchema) body: AdminRevokeLicenseInput,
  ): Promise<void> {
    await this.licensing.adminRevoke(current.id, body.email, body.product);
  }
}

/**
 * Served at `/.well-known/jwks.json` so installed clients can verify tokens
 * offline. Public by design: it only carries public key material.
 */
@ApiTags('licensing')
@Controller('.well-known')
export class LicenseJwksController {
  constructor(private readonly tokens: LicenseTokenService) {}

  @Public()
  @SkipThrottle()
  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Public keys used to verify license tokens' })
  @ApiOkResponse({ description: 'A JWK set with the active signing key' })
  jwks() {
    return this.tokens.jwks();
  }
}
