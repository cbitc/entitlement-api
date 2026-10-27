import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { Roles } from '../common/auth/roles.decorator';
import { AppException } from '../common/errors/app.exception';
import { mapPage, type Page } from '../common/http/pagination';
import { ZodBody, ZodParam, ZodQuery } from '../common/http/zod.decorators';
import { LicensingService } from '../licensing/licensing.service';
import type { AdminLicenseView } from '../licensing/licensing.types';
import { NotificationsService } from '../notifications/notifications.service';
import type { AdminNotificationView } from '../notifications/notifications.types';
import { OrdersService } from '../orders/orders.service';
import type { AdminOrderView } from '../orders/orders.types';
import { JobRunnerService } from '../scheduling/job-runner.service';
import type { JobRunView } from '../scheduling/job.types';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { AdminSubscriptionView } from '../subscriptions/subscriptions.types';
import { UsersService } from '../users/users.service';
import {
  adminActivationParamsSchema,
  adminJobParamsSchema,
  adminJobRunQuerySchema,
  adminLicenseQuerySchema,
  adminNotificationParamsSchema,
  adminNotificationQuerySchema,
  adminOrderParamsSchema,
  adminOrderQuerySchema,
  adminRunJobSchema,
  adminSubscriptionParamsSchema,
  adminSubscriptionQuerySchema,
  adminUpdateUserSchema,
  adminUserParamsSchema,
  adminUserQuerySchema,
  type AdminActivationParams,
  type AdminJobParams,
  type AdminJobRunQuery,
  type AdminLicenseQueryInput,
  type AdminNotificationParams,
  type AdminNotificationQuery,
  type AdminOrderParams,
  type AdminOrderQueryInput,
  type AdminRunJobInput,
  type AdminSubscriptionParams,
  type AdminSubscriptionQueryInput,
  type AdminUpdateUserInput,
  type AdminUserParams,
  type AdminUserQuery,
} from './admin.schemas';
import type { AdminUserDetailView, AdminUserView } from './admin.types';

const toAdminUserView = (user: User): AdminUserView => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});

/**
 * Everything the support console needs to see and act on.
 *
 * The whole controller is `@Roles('ADMIN')`: there is no mixed-audience route
 * here, and the guard re-reads the account on every request, so demoting or
 * disabling an administrator takes effect immediately.
 */
@ApiTags('admin')
@ApiBearerAuth('session')
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly orders: OrdersService,
    private readonly licensing: LicensingService,
    private readonly jobs: JobRunnerService,
    private readonly notifications: NotificationsService,
  ) {}

  /* Users ---------------------------------------------------------------- */

  @Get('users')
  @ApiOperation({ summary: 'Search accounts (admin)' })
  @ApiOkResponse({ description: 'One page of accounts' })
  listUsers(
    @ZodQuery(adminUserQuerySchema) query: AdminUserQuery,
  ): Promise<Page<AdminUserView>> {
    return this.users
      .listPaged(
        { email: query.email, status: query.status, role: query.role },
        query,
      )
      .then((page) => mapPage(page, toAdminUserView));
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'One account with its history counts (admin)' })
  @ApiOkResponse({ description: 'The account and how much it owns' })
  async getUser(
    @ZodParam(adminUserParamsSchema) params: AdminUserParams,
  ): Promise<AdminUserDetailView> {
    const detail = await this.users.findDetail(params.id);
    if (!detail) {
      throw AppException.notFound('User not found', 'UserNotFound');
    }

    return {
      ...toAdminUserView(detail.user),
      subscriptionCount: detail.subscriptions,
      orderCount: detail.orders,
    };
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Disable/enable an account or change its role' })
  @ApiOkResponse({ description: 'The updated account' })
  async updateUser(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(adminUserParamsSchema) params: AdminUserParams,
    @ZodBody(adminUpdateUserSchema) body: AdminUpdateUserInput,
  ): Promise<AdminUserView> {
    let user = await this.users.findByIdOrThrow(params.id);
    if (body.status) {
      user = await this.users.setStatus(current.id, params.id, body.status);
    }
    if (body.role) {
      user = await this.users.setRole(current.id, params.id, body.role);
    }
    return toAdminUserView(user);
  }

  /* Subscriptions -------------------------------------------------------- */

  @Get('subscriptions')
  @ApiOperation({ summary: 'Search subscriptions (admin)' })
  @ApiOkResponse({ description: 'One page of subscriptions' })
  listSubscriptions(
    @ZodQuery(adminSubscriptionQuerySchema) query: AdminSubscriptionQueryInput,
  ): Promise<Page<AdminSubscriptionView>> {
    return this.subscriptions.listAllPaged(
      {
        userId: query.userId,
        productId: query.productId,
        status: query.status,
        planVersionId: query.planVersionId,
        endsBefore: query.endsBefore,
      },
      query,
    );
  }

  @Get('subscriptions/:id')
  @ApiOperation({ summary: 'One subscription, whoever owns it (admin)' })
  @ApiOkResponse({ description: 'The subscription' })
  getSubscription(
    @ZodParam(adminSubscriptionParamsSchema) params: AdminSubscriptionParams,
  ): Promise<AdminSubscriptionView> {
    return this.subscriptions.getAny(params.id);
  }

  @Post('subscriptions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a subscription immediately (admin, not at the boundary)',
  })
  @ApiOkResponse({ description: 'The canceled subscription' })
  cancelSubscription(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(adminSubscriptionParamsSchema) params: AdminSubscriptionParams,
  ): Promise<AdminSubscriptionView> {
    return this.subscriptions.cancelImmediately(current.id, params.id);
  }

  /* Orders --------------------------------------------------------------- */

  @Get('orders')
  @ApiOperation({ summary: 'Search orders (admin)' })
  @ApiOkResponse({ description: 'One page of orders' })
  listOrders(
    @ZodQuery(adminOrderQuerySchema) query: AdminOrderQueryInput,
  ): Promise<Page<AdminOrderView>> {
    return this.orders.listAllPaged(
      {
        status: query.status,
        userId: query.userId,
        number: query.number,
        productId: query.productId,
        from: query.from,
        to: query.to,
      },
      query,
    );
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'One order, whoever owns it (admin)' })
  @ApiOkResponse({ description: 'The order' })
  getOrder(
    @ZodParam(adminOrderParamsSchema) params: AdminOrderParams,
  ): Promise<AdminOrderView> {
    return this.orders.getAny(params.id);
  }

  @Post('orders/:id/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile an order with the provider (admin)' })
  @ApiOkResponse({ description: 'The order after reconciliation' })
  syncOrder(
    @ZodParam(adminOrderParamsSchema) params: AdminOrderParams,
  ): Promise<AdminOrderView> {
    return this.orders.syncAsAdmin(params.id);
  }

  /* Jobs ----------------------------------------------------------------- */

  @Post('jobs/:name/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a scheduled job once (admin replacement for cron)',
  })
  @ApiOkResponse({ description: 'The job counters' })
  async runJob(
    @ZodParam(adminJobParamsSchema) params: AdminJobParams,
    @ZodBody(adminRunJobSchema) body: AdminRunJobInput,
  ): Promise<unknown> {
    const outcome = await this.jobs.run(params.name, {
      limit: body.limit,
      source: 'admin',
    });

    // The console renders whatever the job returned; a skipped run is the one
    // case where there are no counters to show.
    if (outcome.status === 'SKIPPED') {
      return { skipped: true };
    }
    return outcome.result;
  }

  @Get('jobs/runs')
  @ApiOperation({ summary: 'Recent job runs, newest first' })
  @ApiOkResponse({ description: 'Run history with duration and result' })
  listJobRuns(
    @ZodQuery(adminJobRunQuerySchema) query: AdminJobRunQuery,
  ): Promise<JobRunView[]> {
    return this.jobs.listRuns({ name: query.name, limit: query.limit });
  }

  /* Notifications -------------------------------------------------------- */

  @Get('notifications')
  @ApiOperation({ summary: 'Search outbound mail and its delivery status' })
  @ApiOkResponse({ description: 'One page of notifications' })
  listNotifications(
    @ZodQuery(adminNotificationQuerySchema) query: AdminNotificationQuery,
  ): Promise<Page<AdminNotificationView>> {
    return this.notifications.listPaged(
      {
        status: query.status,
        type: query.type,
        email: query.email,
        userId: query.userId,
      },
      query,
    );
  }

  @Post('notifications/:id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue a notification for another delivery attempt',
  })
  @ApiOkResponse({ description: 'The notification back in PENDING' })
  resendNotification(
    @ZodParam(adminNotificationParamsSchema) params: AdminNotificationParams,
  ): Promise<AdminNotificationView> {
    return this.notifications.resend(params.id);
  }

  /* Licenses ------------------------------------------------------------- */

  @Get('licenses')
  @ApiOperation({ summary: 'Search licenses and their activated devices' })
  @ApiOkResponse({ description: 'One page of licenses' })
  listLicenses(
    @ZodQuery(adminLicenseQuerySchema) query: AdminLicenseQueryInput,
  ): Promise<Page<AdminLicenseView>> {
    return this.licensing.adminList(
      { email: query.email, userId: query.userId, product: query.product },
      query,
    );
  }

  @Post('activations/:id/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Release an activation slot on behalf of a user' })
  @ApiNoContentResponse({ description: 'The machine is no longer activated' })
  deactivate(
    @ZodParam(adminActivationParamsSchema) params: AdminActivationParams,
  ): Promise<void> {
    return this.licensing.deactivateAsAdmin(params.id);
  }
}
