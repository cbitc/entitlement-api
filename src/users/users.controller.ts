import { Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { AppException } from '../common/errors/app.exception';
import { ZodBody } from '../common/http/zod.decorators';
import { toUserProfile, type UserProfile } from './user-profile';
import { UsersService } from './users.service';
import { updateProfileSchema, type UpdateProfileInput } from './users.schemas';

@ApiTags('users')
@ApiBearerAuth('session')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in account' })
  @ApiOkResponse({ description: 'The caller profile' })
  async me(@CurrentUser() current: AuthenticatedUser): Promise<UserProfile> {
    const user = await this.users.findById(current.id);
    if (!user) {
      // The token was valid a moment ago; the account disappeared since.
      throw AppException.unauthorized('Invalid or expired token');
    }
    return toUserProfile(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the display name of the signed-in account' })
  @ApiOkResponse({ description: 'The updated caller profile' })
  async updateMe(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(updateProfileSchema) body: UpdateProfileInput,
  ): Promise<UserProfile> {
    const user = await this.users.updateProfile(current.id, body);
    return toUserProfile(user);
  }
}
