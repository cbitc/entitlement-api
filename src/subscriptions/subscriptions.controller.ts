import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { ZodBody, ZodParam } from '../common/http/zod.decorators';
import {
  changeSubscriptionSchema,
  createSubscriptionSchema,
  subscriptionChangeParamsSchema,
  subscriptionParamsSchema,
  type ChangeSubscriptionInput,
  type CreateSubscriptionInput,
} from './subscriptions.schemas';
import { SubscriptionsService } from './subscriptions.service';
import type { SubscriptionView } from './subscriptions.types';

type SubscriptionParams = { readonly id: string };
type SubscriptionChangeParams = {
  readonly id: string;
  readonly changeId: string;
};

@ApiTags('subscriptions')
@ApiBearerAuth('session')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post()
  @ApiOperation({ summary: 'Subscribe to a product plan' })
  @ApiCreatedResponse({ description: 'The new subscription' })
  create(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(createSubscriptionSchema) body: CreateSubscriptionInput,
  ): Promise<SubscriptionView> {
    return this.subscriptions.create(current.id, body);
  }

  @Get()
  @ApiOperation({ summary: 'The caller subscriptions' })
  @ApiOkResponse({ description: 'Subscriptions, newest first' })
  list(@CurrentUser() current: AuthenticatedUser): Promise<SubscriptionView[]> {
    return this.subscriptions.listForUser(current.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One subscription of the caller' })
  @ApiOkResponse({ description: 'The subscription' })
  get(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionParamsSchema) params: SubscriptionParams,
  ): Promise<SubscriptionView> {
    return this.subscriptions.getForUser(current.id, params.id);
  }

  @Post(':id/changes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule a plan or interval change for the period end',
  })
  @ApiOkResponse({ description: 'The subscription with its pending change' })
  change(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionParamsSchema) params: SubscriptionParams,
    @ZodBody(changeSubscriptionSchema) body: ChangeSubscriptionInput,
  ): Promise<SubscriptionView> {
    return this.subscriptions.change(current.id, params.id, body);
  }

  @Delete(':id/changes/:changeId')
  @ApiOperation({ summary: 'Drop the scheduled change' })
  @ApiOkResponse({ description: 'The subscription without a pending change' })
  cancelChange(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionChangeParamsSchema) params: SubscriptionChangeParams,
  ): Promise<SubscriptionView> {
    return this.subscriptions.cancelChange(
      current.id,
      params.id,
      params.changeId,
    );
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend entitlement until the subscription resumes',
  })
  @ApiOkResponse({ description: 'The paused subscription' })
  pause(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionParamsSchema) params: SubscriptionParams,
  ): Promise<SubscriptionView> {
    return this.subscriptions.pause(current.id, params.id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused subscription' })
  @ApiOkResponse({ description: 'The running subscription' })
  resume(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionParamsSchema) params: SubscriptionParams,
  ): Promise<SubscriptionView> {
    return this.subscriptions.resume(current.id, params.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel at the end of the current period' })
  @ApiOkResponse({
    description: 'The subscription with its pending cancellation',
  })
  cancel(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(subscriptionParamsSchema) params: SubscriptionParams,
  ): Promise<SubscriptionView> {
    return this.subscriptions.cancel(current.id, params.id);
  }
}
