import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Order, type PaymentProvider } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppException } from '../common/errors/app.exception';
import {
  pageOf,
  skipFor,
  type Page,
  type Pagination,
} from '../common/http/pagination';
import { AppConfig } from '../config/app-config.service';
import { PaymentGateway } from '../infra/payments/payment-gateway';
import type {
  PaymentNotificationPayload,
  ProviderPaymentStatus,
} from '../infra/payments/payment-gateway';
import { PrismaService } from '../infra/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionLifecycleService } from '../subscriptions/subscription-lifecycle.service';
import {
  SubscriptionPeriodsService,
  VERSION_INCLUDE,
  isRenewable,
  openKeyFor,
  priceFor,
  type VersionRow,
} from '../subscriptions/subscription-periods.service';
import { OrderFulfillmentService } from './order-fulfillment.service';
import { paymentProviderFailed } from './payment-provider.error';
import type { CreateOrderInput, RefundOrderInput } from './orders.schemas';
import type { AdminOrderView, CheckoutView, OrderView } from './orders.types';

const ORDER_INCLUDE = Prisma.validator<Prisma.OrderInclude>()({
  product: { select: { code: true } },
  planVersion: {
    select: { id: true, version: true, plan: { select: { code: true } } },
  },
  sourcePeriod: { select: { endsAt: true } },
  payments: { orderBy: { initiatedAt: 'desc' } },
  refunds: { orderBy: { requestedAt: 'desc' } },
});

type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** Admin rows also name the buyer; the customer view never needs it. */
const ADMIN_ORDER_INCLUDE = Prisma.validator<Prisma.OrderInclude>()({
  ...ORDER_INCLUDE,
  user: { select: { id: true, email: true } },
});

type AdminOrderRow = Prisma.OrderGetPayload<{
  include: typeof ADMIN_ORDER_INCLUDE;
}>;

const ORDER_NUMBER_PREFIX = 'ORD';
const RENEWAL_ACTIVE_STATUSES = ['TRIALING', 'ACTIVE'] as const;
/** Provider statuses that mean the money was captured. */
const CAPTURED_EVENTS = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

export interface AdminOrderFilter {
  readonly status?: Order['status'];
  readonly userId?: string;
  readonly number?: string;
  readonly productId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

const newOrderNumber = (): string =>
  `${ORDER_NUMBER_PREFIX}${Date.now().toString(36).toUpperCase()}${randomBytes(
    4,
  )
    .toString('hex')
    .toUpperCase()}`;

const addMinutes = (from: Date, minutes: number): Date =>
  new Date(from.getTime() + minutes * 60_000);

const toOrderView = (row: OrderRow): OrderView => ({
  id: row.id,
  number: row.number,
  kind: row.kind,
  status: row.status,
  productCode: row.product.code,
  planCode: row.planVersion.plan.code,
  planVersionId: row.planVersionId,
  version: row.planVersion.version,
  interval: row.interval,
  unitPriceCents: row.unitPriceCents,
  amountCents: row.amountCents,
  currency: row.currency,
  subscriptionId: row.subscriptionId,
  appliesAt:
    row.kind === 'NEW_SUBSCRIPTION'
      ? null
      : (row.sourcePeriod?.endsAt.toISOString() ?? null),
  expiresAt: row.expiresAt.toISOString(),
  paidAt: row.paidAt?.toISOString() ?? null,
  fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
  closedAt: row.closedAt?.toISOString() ?? null,
  failureReason: row.failureReason,
  refundedCents: row.refunds
    .filter((refund) => refund.status === 'SUCCEEDED')
    .reduce((sum, refund) => sum + refund.amountCents, 0),
  payments: row.payments.map((payment) => ({
    id: payment.id,
    provider: payment.provider,
    status: payment.status,
    amountCents: payment.amountCents,
    currency: payment.currency,
    paidAt: payment.paidAt?.toISOString() ?? null,
  })),
  refunds: row.refunds.map((refund) => ({
    id: refund.id,
    amountCents: refund.amountCents,
    status: refund.status,
    reason: refund.reason,
    requestedAt: refund.requestedAt.toISOString(),
    completedAt: refund.completedAt?.toISOString() ?? null,
  })),
});

const toAdminOrderView = (row: AdminOrderRow): AdminOrderView => ({
  ...toOrderView(row),
  userId: row.user.id,
  userEmail: row.user.email,
});

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly gateway: PaymentGateway,
    private readonly periods: SubscriptionPeriodsService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly notifications: NotificationsService,
  ) {}

  async listForUser(userId: string): Promise<OrderView[]> {
    const rows = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return Promise.all(rows.map((row) => this.loadView(row.id)));
  }

  async getForUser(userId: string, id: string): Promise<OrderView> {
    const owned = await this.prisma.order.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    return this.loadView(id);
  }

  async listAllPaged(
    filter: AdminOrderFilter,
    pagination: Pagination,
  ): Promise<Page<AdminOrderView>> {
    const where: Prisma.OrderWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.number ? { number: filter.number } : {}),
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.limit,
        include: ADMIN_ORDER_INCLUDE,
      }),
      this.prisma.order.count({ where }),
    ]);

    return pageOf(rows.map(toAdminOrderView), total, pagination);
  }

  async getAny(id: string): Promise<AdminOrderView> {
    const exists = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    return this.loadAdminView(id);
  }

  /** Creates an unpaid checkout. Nothing is granted until the callback lands. */
  async create(
    userId: string,
    input: CreateOrderInput,
    now = new Date(),
  ): Promise<OrderView> {
    const product = await this.prisma.product.findUnique({
      where: { code: input.productCode },
      select: { id: true, active: true },
    });
    if (!product || !product.active) {
      throw AppException.notFound(
        `Unknown product "${input.productCode}"`,
        'ProductNotFound',
      );
    }

    const plan = await this.prisma.plan.findUnique({
      where: {
        productId_code: { productId: product.id, code: input.planCode },
      },
      select: { id: true },
    });
    if (!plan) {
      throw AppException.notFound(
        `Unknown plan "${input.planCode}"`,
        'PlanNotFound',
      );
    }

    const version = await this.publishedVersion(plan.id);
    if (!version) {
      throw AppException.conflict(
        'This plan is not for sale',
        'PlanNotSellable',
      );
    }

    const price = priceFor(version, input.interval, input.currency);
    if (!price) {
      throw AppException.unprocessable(
        `This plan is not sold as ${input.interval} in ${input.currency}`,
        'TermNotAvailable',
      );
    }

    const live = await this.prisma.subscription.findFirst({
      where: {
        userId,
        productId: product.id,
        openKey: openKeyFor(userId, product.id),
      },
      select: { id: true },
    });
    if (live) {
      throw AppException.conflict(
        'An active subscription to this product already exists',
        'SubscriptionAlreadyActive',
      );
    }

    try {
      const order = await this.prisma.order.create({
        data: {
          number: newOrderNumber(),
          userId,
          productId: product.id,
          kind: 'NEW_SUBSCRIPTION',
          planVersionId: version.id,
          interval: input.interval,
          unitPriceCents: price.priceCents,
          currency: price.currency,
          amountCents: price.priceCents,
          pendingKey: openKeyFor(userId, product.id),
          expiresAt: addMinutes(now, this.config.orderTtlMinutes),
        },
      });

      return this.loadView(order.id);
    } catch (error) {
      if (this.isUniqueViolation(error, 'pendingKey')) {
        throw AppException.conflict(
          'An unpaid order already exists for this product',
          'OrderAlreadyPending',
        );
      }
      throw error;
    }
  }

  async cancel(
    userId: string,
    id: string,
    now = new Date(),
  ): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    if (order.status !== 'PENDING') {
      throw AppException.conflict(
        'Only an unpaid order can be cancelled',
        'OrderNotCancelable',
      );
    }

    await this.prisma.order.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: now,
        pendingKey: null,
        renewalKey: null,
      },
    });

    return this.loadView(id);
  }

  /** Starts a provider checkout for an unpaid order. */
  async createPayment(
    userId: string,
    id: string,
    now = new Date(),
  ): Promise<CheckoutView> {
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      include: {
        product: { select: { code: true } },
        planVersion: {
          select: { version: true, plan: { select: { code: true } } },
        },
      },
    });
    if (!order) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    if (order.status !== 'PENDING') {
      throw AppException.conflict(
        'This order can no longer be paid',
        'OrderNotPayable',
      );
    }
    if (order.expiresAt <= now) {
      throw AppException.conflict('This order has expired', 'OrderExpired');
    }

    const provider = this.gateway.provider;

    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider,
        amountCents: order.amountCents,
        currency: order.currency,
      },
    });

    try {
      const instruction = await this.gateway.createPayment({
        orderNumber: order.number,
        subject: `${order.product.code} ${order.planVersion.plan.code} v${order.planVersion.version}`,
        amountCents: order.amountCents,
        currency: order.currency,
        notifyUrl: this.config.alipay.notifyUrl,
        returnUrl: this.config.alipay.returnUrl,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PENDING',
          providerTradeNo: instruction.providerTradeNo ?? null,
        },
      });

      return {
        order: await this.loadView(order.id),
        payment: {
          id: payment.id,
          provider,
          status: 'PENDING',
        },
        payUrl: instruction.payUrl,
      };
    } catch (error) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureMessage: this.errorMessage(error),
        },
      });
      throw paymentProviderFailed('The payment provider is unavailable');
    }
  }

  /**
   * Handles one provider callback. Returns true when the event was accepted, so
   * the controller can answer "success" and stop the provider retrying.
   */
  async handleNotification(
    providerCode: string,
    payload: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const expected = this.gateway.provider.toLowerCase();
    if (providerCode.toLowerCase() !== expected) {
      throw AppException.notFound(
        `Unknown payment provider "${providerCode}"`,
        'PaymentProviderNotFound',
      );
    }

    let parsed: PaymentNotificationPayload;
    try {
      parsed = this.gateway.parseNotification(payload);
    } catch (error) {
      this.logger.warn(`Malformed notification: ${this.errorMessage(error)}`);
      return false;
    }

    const verified = this.gateway.verifyNotification(payload);
    if (!verified) {
      await this.recordRejected(parsed, payload);
      return false;
    }

    return this.applyNotification(parsed, payload, new Date());
  }

  /** Admin-only: refunds part or all of a captured payment. */
  async refund(
    adminUserId: string,
    orderId: string,
    input: RefundOrderInput,
    now = new Date(),
  ): Promise<AdminOrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true, refunds: true },
    });
    if (!order) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    if (
      order.status !== 'PAID' &&
      order.status !== 'FULFILLED' &&
      order.status !== 'CLOSED'
    ) {
      throw AppException.conflict(
        'This order has nothing to refund',
        'OrderNotRefundable',
      );
    }

    const payment = order.payments.find(
      (candidate) => candidate.status === 'SUCCEEDED',
    );
    if (!payment) {
      throw AppException.conflict(
        'No captured payment for this order',
        'PaymentNotFound',
      );
    }

    const reserved = order.refunds
      .filter((refund) => refund.status !== 'FAILED')
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const remaining = payment.amountCents - reserved;
    const amountCents = input.amountCents ?? remaining;
    if (amountCents <= 0 || amountCents > remaining) {
      throw AppException.unprocessable(
        `Refund must be between 1 and ${remaining} cents`,
        'RefundExceedsPayment',
      );
    }

    const refund = await this.prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        amountCents,
        currency: payment.currency,
        reason: input.reason,
        requestedByUserId: adminUserId,
      },
    });

    try {
      const result = await this.gateway.refund({
        refundNumber: refund.id,
        orderNumber: order.number,
        providerTradeNo: payment.providerTradeNo ?? undefined,
        amountCents,
        currency: payment.currency,
        reason: input.reason,
      });

      const isFull = reserved + amountCents === payment.amountCents;
      const unfulfilled = order.appliedPeriodId === null;

      await this.prisma.$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: 'SUCCEEDED',
            providerRefundNo: result.providerRefundNo,
            completedAt: now,
          },
        });

        await this.notifications.enqueueRefundSucceeded(tx, refund.id);

        await tx.order.update({
          where: { id: order.id },
          data: {
            // A refunded draft can never be fulfilled, even when only part of
            // the money is returned: the customer did not keep the full term.
            ...(isFull || unfulfilled ? { status: 'REFUNDED' } : {}),
            ...(isFull || unfulfilled
              ? { pendingKey: null, renewalKey: null }
              : {}),
          },
        });

        if (!isFull || !order.subscriptionId || !order.appliedPeriodId) {
          return;
        }

        const subscription = await tx.subscription.findUnique({
          where: { id: order.subscriptionId },
          select: { id: true, status: true },
        });
        if (
          !subscription ||
          subscription.status === 'CANCELED' ||
          subscription.status === 'EXPIRED'
        ) {
          return;
        }

        const current = await tx.subscriptionPeriod.findFirst({
          where: {
            subscriptionId: order.subscriptionId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (current?.id !== order.appliedPeriodId) {
          return;
        }

        await this.lifecycle.terminate(tx, {
          subscriptionId: order.subscriptionId,
          status: 'CANCELED',
          closeReason: 'CANCELED',
          endedAt: now,
          now,
          actorUserId: adminUserId,
          recordCancellation: true,
        });
      });
    } catch (error) {
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: {
          status: 'FAILED',
          failureReason: this.errorMessage(error),
        },
      });
      throw paymentProviderFailed('The refund was rejected by the provider');
    }

    return this.loadAdminView(order.id);
  }

  /**
   * Creates the renewal checkouts that are due within the lead window.
   *
   * Unpaid orders are drafts: a later change or cancellation closes them and the
   * job recreates the order with the new terms.
   */
  async createRenewalOrders(
    now = new Date(),
    limit = 200,
  ): Promise<{ created: number; skipped: number }> {
    const cutoff = new Date(
      now.getTime() + this.config.renewalLeadDays * 24 * 60 * 60 * 1000,
    );

    const periods = await this.prisma.subscriptionPeriod.findMany({
      where: {
        status: 'ACTIVE',
        endsAt: { gt: now, lte: cutoff },
        subscription: { status: { in: [...RENEWAL_ACTIVE_STATUSES] } },
      },
      orderBy: { endsAt: 'asc' },
      take: limit,
      include: {
        subscription: {
          select: { id: true, userId: true, productId: true },
        },
        planVersion: { include: VERSION_INCLUDE },
      },
    });

    let created = 0;
    let skipped = 0;

    for (const period of periods) {
      try {
        const orderId = await this.prisma.$transaction(async (tx) => {
          await this.periods.lock(tx, period.subscriptionId);

          const current = await this.periods.current(tx, period.subscriptionId);
          if (!current || current.id !== period.id) {
            return null;
          }

          const existing = await tx.order.findFirst({
            where: {
              sourcePeriodId: period.id,
              status: { in: ['PENDING', 'PAID'] },
            },
            select: { id: true },
          });
          if (existing) {
            return null;
          }

          // A scheduled cancellation means there is nothing to sell.
          const cancellation = await tx.subscriptionChange.findFirst({
            where: {
              subscriptionId: period.subscriptionId,
              status: 'PENDING',
              kind: 'CANCEL',
              effectiveAt: { lte: period.endsAt },
            },
            select: { id: true },
          });
          if (cancellation) {
            return null;
          }

          const change = await tx.subscriptionChange.findFirst({
            where: {
              subscriptionId: period.subscriptionId,
              status: 'PENDING',
              kind: 'CHANGE',
              effectiveAt: { lte: period.endsAt },
            },
            include: { targetPlanVersion: { include: VERSION_INCLUDE } },
            orderBy: { effectiveAt: 'asc' },
          });

          const version: VersionRow =
            change?.targetPlanVersion ?? period.planVersion;
          const interval = change?.targetInterval ?? period.interval;
          const currency = period.currency ?? 'cny';

          if (!isRenewable(version.status) || !interval) {
            return null;
          }
          const price = priceFor(version, interval, currency);
          if (!price) {
            return null;
          }

          const order = await tx.order.create({
            data: {
              number: newOrderNumber(),
              userId: period.subscription.userId,
              productId: period.subscription.productId,
              subscriptionId: period.subscriptionId,
              kind: period.kind === 'TRIAL' ? 'TRIAL_CONVERSION' : 'RENEWAL',
              planVersionId: version.id,
              interval,
              unitPriceCents: price.priceCents,
              currency,
              amountCents: price.priceCents,
              sourcePeriodId: period.id,
              changeId: change?.id ?? null,
              renewalKey: period.id,
              // Paying after the boundary is pointless: the period is gone.
              expiresAt: period.endsAt,
            },
            select: { id: true },
          });

          return order.id;
        });

        if (orderId) {
          created += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        skipped += 1;
        this.logger.warn(
          `Renewal order skipped for period ${period.id}: ${this.errorMessage(error)}`,
        );
      }
    }

    return { created, skipped };
  }

  /**
   * Boundary driver: applies paid renewal orders and expires everything unpaid.
   * Per-subscription failures are logged, never allowed to stop the batch.
   */
  async settleDueSubscriptions(
    now = new Date(),
    limit = 200,
  ): Promise<{
    fulfilled: number;
    canceled: number;
    expired: number;
    failed: number;
  }> {
    const due = await this.prisma.subscriptionPeriod.findMany({
      where: {
        status: 'ACTIVE',
        endsAt: { lte: now },
        subscription: {
          status: { in: [...RENEWAL_ACTIVE_STATUSES, 'PAUSED'] },
        },
      },
      select: { subscriptionId: true },
      take: limit,
    });

    let fulfilled = 0;
    let canceled = 0;
    let expired = 0;
    let failed = 0;

    for (const row of due) {
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          await this.periods.lock(tx, row.subscriptionId);

          const subscription = await tx.subscription.findUnique({
            where: { id: row.subscriptionId },
          });
          if (
            !subscription ||
            (subscription.status !== 'TRIALING' &&
              subscription.status !== 'ACTIVE' &&
              subscription.status !== 'PAUSED')
          ) {
            return 'skipped' as const;
          }

          const period = await this.periods.current(tx, row.subscriptionId);
          if (!period || period.endsAt > now) {
            return 'skipped' as const;
          }

          const cancellation = await tx.subscriptionChange.findFirst({
            where: {
              subscriptionId: row.subscriptionId,
              status: 'PENDING',
              kind: 'CANCEL',
              effectiveAt: { lte: period.endsAt },
            },
            select: { id: true },
          });

          // A paused subscription never auto-renews, even if an old paid
          // renewal exists: the money is kept visible for an admin refund.
          if (subscription.status === 'PAUSED') {
            await tx.order.updateMany({
              where: {
                sourcePeriodId: period.id,
                status: 'PAID',
                appliedPeriodId: null,
              },
              data: { failureReason: 'SUBSCRIPTION_PAUSED' },
            });

            if (cancellation) {
              await tx.subscriptionChange.update({
                where: { id: cancellation.id },
                data: {
                  status: 'APPLIED',
                  pendingKey: null,
                  appliedAt: period.endsAt,
                },
              });
            }

            await this.lifecycle.terminate(tx, {
              subscriptionId: row.subscriptionId,
              status: cancellation ? 'CANCELED' : 'EXPIRED',
              closeReason: cancellation ? 'CANCELED' : 'PAUSED',
              endedAt: period.endsAt,
              now,
            });
            return cancellation ? ('canceled' as const) : ('expired' as const);
          }

          const paid = await tx.order.findFirst({
            where: { sourcePeriodId: period.id, status: 'PAID' },
          });
          if (paid) {
            await this.fulfillment.applyRenewal(tx, paid, now);
            return 'fulfilled' as const;
          }

          if (cancellation) {
            await tx.subscriptionChange.update({
              where: { id: cancellation.id },
              data: {
                status: 'APPLIED',
                pendingKey: null,
                appliedAt: period.endsAt,
              },
            });
            await this.lifecycle.terminate(tx, {
              subscriptionId: row.subscriptionId,
              status: 'CANCELED',
              closeReason: 'CANCELED',
              endedAt: period.endsAt,
              now,
            });
            return 'canceled' as const;
          }

          await tx.subscriptionChange.updateMany({
            where: { subscriptionId: row.subscriptionId, status: 'PENDING' },
            data: {
              status: 'FAILED',
              pendingKey: null,
              appliedAt: period.endsAt,
              failureReason: 'UNPAID',
            },
          });
          await this.lifecycle.terminate(tx, {
            subscriptionId: row.subscriptionId,
            status: 'EXPIRED',
            closeReason: 'EXPIRED',
            endedAt: period.endsAt,
            now,
          });
          return 'expired' as const;
        });

        if (outcome === 'fulfilled') {
          fulfilled += 1;
        } else if (outcome === 'canceled') {
          canceled += 1;
        } else if (outcome === 'expired') {
          expired += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Settlement failed for subscription ${row.subscriptionId}`,
          error,
        );
      }
    }

    return { fulfilled, canceled, expired, failed };
  }

  /** Closes checkouts that were never paid. */
  async expireOrders(
    now = new Date(),
    limit = 200,
  ): Promise<{ closed: number }> {
    const pending = await this.prisma.order.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      select: { id: true },
      take: limit,
    });

    let closed = 0;
    for (const row of pending) {
      const result = await this.prisma.order.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'CLOSED',
          closedAt: now,
          pendingKey: null,
          renewalKey: null,
        },
      });
      closed += result.count;
    }

    return { closed };
  }

  /**
   * Owner-triggered reconciliation.
   *
   * Callbacks can be lost or unreachable (a local sandbox cannot be called
   * back), so the provider is asked directly and the same capture path is used.
   */
  sync(userId: string, id: string, now = new Date()): Promise<OrderView> {
    return this.reconcile(id, now, userId);
  }

  /** Support-triggered reconciliation: same path, no ownership filter. */
  async syncAsAdmin(id: string, now = new Date()): Promise<AdminOrderView> {
    await this.reconcile(id, now, null);
    return this.getAny(id);
  }

  private async reconcile(
    id: string,
    now: Date,
    ownerUserId: string | null,
  ): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id, ...(ownerUserId ? { userId: ownerUserId } : {}) },
      select: { id: true, number: true, status: true },
    });
    if (!order) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    if (order.status === 'FULFILLED' || order.status === 'REFUNDED') {
      return this.loadView(order.id);
    }

    // A closed order is still queried: the buyer may have paid after the
    // checkout window. The capture path decides whether it can be fulfilled
    // or only recorded for a refund.
    const status = await this.gateway.queryPayment(order.number);
    if (status.state === 'NOT_FOUND') {
      throw AppException.conflict(
        'The provider has no record of this payment yet',
        'PaymentNotConfirmed',
      );
    }
    if (status.state === 'PENDING') {
      throw AppException.conflict(
        'The payment is still pending at the provider',
        'PaymentPending',
      );
    }
    if (status.state === 'CLOSED') {
      throw AppException.conflict(
        'The provider closed this payment',
        'PaymentClosed',
      );
    }

    const outcome = await this.prisma.$transaction((tx) =>
      this.captureAndFulfill(
        tx,
        order.id,
        this.providerPayload(order.number, status),
        now,
      ),
    );
    if (outcome.status === 'FAILED') {
      throw outcome.reason === 'AMOUNT_MISMATCH'
        ? AppException.unprocessable(
            'The captured amount does not match the order',
            'AmountMismatch',
          )
        : AppException.conflict(
            'The payment could not be applied',
            outcome.reason ?? 'PaymentNotApplied',
          );
    }

    return this.loadView(order.id);
  }

  /**
   * Cron-friendly sweep for checkouts whose callback never arrived.
   * A captured payment is applied even if the callback is still in flight.
   */
  async syncPendingOrders(
    now = new Date(),
    limit = 100,
  ): Promise<{ synced: number; pending: number; failed: number }> {
    const windowStart = new Date(
      now.getTime() - this.config.paymentSyncWindowHours * 60 * 60 * 1000,
    );
    const rows = await this.prisma.order.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          {
            status: 'CLOSED',
            closedAt: { gte: windowStart },
            payments: { none: { status: 'SUCCEEDED' } },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, number: true },
    });

    let synced = 0;
    let pending = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const status = await this.gateway.queryPayment(row.number);
        if (status.state !== 'CAPTURED') {
          pending += 1;
          continue;
        }

        const outcome = await this.prisma.$transaction((tx) =>
          this.captureAndFulfill(
            tx,
            row.id,
            this.providerPayload(row.number, status),
            now,
          ),
        );
        if (outcome.status === 'PROCESSED') {
          synced += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Payment sync failed for order ${row.number}: ${this.errorMessage(error)}`,
        );
      }
    }

    return { synced, pending, failed };
  }

  private providerPayload(
    orderNumber: string,
    status: ProviderPaymentStatus,
  ): PaymentNotificationPayload {
    return {
      // Not a provider event id: reconciliation has no inbound event.
      externalId: `SYNC-${orderNumber}`,
      eventType: 'TRADE_SUCCESS',
      orderNumber,
      providerTradeNo: status.providerTradeNo,
      amountCents: status.amountCents ?? 0,
      currency: status.currency ?? 'cny',
      paidAt: status.paidAt,
      buyerId: status.buyerId,
    };
  }

  private async applyNotification(
    parsed: PaymentNotificationPayload,
    payload: Readonly<Record<string, string>>,
    now: Date,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const notification = await tx.paymentNotification.create({
          data: {
            provider: this.gateway.provider,
            externalId: parsed.externalId,
            verified: true,
            eventType: parsed.eventType,
            payload: payload as Prisma.InputJsonObject,
          },
        });

        const order = await tx.order.findUnique({
          where: { number: parsed.orderNumber },
          select: { id: true },
        });
        if (!order) {
          await this.finishNotification(
            tx,
            notification.id,
            'IGNORED',
            'ORDER_NOT_FOUND',
          );
          return true;
        }

        if (!CAPTURED_EVENTS.has(parsed.eventType)) {
          await tx.payment.updateMany({
            where: {
              orderId: order.id,
              status: { in: ['INITIATED', 'PENDING'] },
            },
            data: { status: 'CLOSED', closedAt: now },
          });
          await this.finishNotification(
            tx,
            notification.id,
            'IGNORED',
            `EVENT_${parsed.eventType}`,
            order.id,
          );
          return true;
        }

        const outcome = await this.captureAndFulfill(tx, order.id, parsed, now);
        await this.finishNotification(
          tx,
          notification.id,
          outcome.status,
          outcome.reason,
          outcome.orderId,
          outcome.paymentId,
        );
        return true;
      });
    } catch (error) {
      if (this.isUniqueViolation(error, 'externalId')) {
        // A replayed callback: the first one already did the work.
        return true;
      }
      throw error;
    }
  }

  /**
   * The single "money is in, apply it" path shared by the callback and sync.
   *
   * A business failure is recorded rather than thrown: the money is real, so
   * the order stays PAID with a reason for an operator to refund or retry.
   */
  private async captureAndFulfill(
    tx: Prisma.TransactionClient,
    orderId: string,
    parsed: PaymentNotificationPayload,
    now: Date,
    provider: PaymentProvider = this.gateway.provider,
  ): Promise<{
    status: 'PROCESSED' | 'FAILED';
    reason: string | null;
    orderId: string;
    paymentId?: string;
  }> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return { status: 'FAILED', reason: 'ORDER_NOT_FOUND', orderId };
    }

    if (
      parsed.amountCents !== order.amountCents ||
      parsed.currency.toLowerCase() !== order.currency.toLowerCase()
    ) {
      return { status: 'FAILED', reason: 'AMOUNT_MISMATCH', orderId };
    }

    await tx.$queryRaw`
      SELECT id FROM \`PaymentOrder\` WHERE id = ${order.id} FOR UPDATE
    `;
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    if (fresh.status === 'FULFILLED' || fresh.status === 'REFUNDED') {
      return { status: 'PROCESSED', reason: 'ALREADY_FULFILLED', orderId };
    }

    if (fresh.status === 'CLOSED') {
      const closedByExpiry =
        fresh.closedAt !== null &&
        fresh.closedAt.getTime() >= fresh.expiresAt.getTime();
      const withinGrace =
        now.getTime() <=
        fresh.expiresAt.getTime() +
          this.config.latePaymentGraceMinutes * 60 * 1000;

      // A user cancellation or an old checkout is never fulfilled: the money
      // is recorded so an operator can refund it, and the order stays CLOSED.
      if (!closedByExpiry || !withinGrace) {
        const payment = await this.recordSuccess(
          tx,
          fresh,
          parsed,
          now,
          provider,
        );
        await tx.order.update({
          where: { id: fresh.id },
          data: { failureReason: 'LATE_PAYMENT' },
        });
        this.logger.warn(
          `Late payment captured for closed order ${fresh.number}; refund required`,
        );
        return {
          status: 'FAILED',
          reason: 'LATE_PAYMENT',
          orderId: fresh.id,
          paymentId: payment.id,
        };
      }
    }

    const payment = await this.recordSuccess(tx, fresh, parsed, now, provider);

    await tx.order.update({
      where: { id: fresh.id },
      data: {
        status: 'PAID',
        paidAt: parsed.paidAt ?? now,
        pendingKey: null,
        failureReason: null,
      },
    });

    const paidOrder = await tx.order.findUniqueOrThrow({
      where: { id: fresh.id },
    });

    try {
      if (paidOrder.kind === 'NEW_SUBSCRIPTION') {
        await this.fulfillment.applyNewSubscription(tx, paidOrder, now);
      } else {
        const current = await tx.subscriptionPeriod.findFirst({
          where: {
            subscriptionId: paidOrder.subscriptionId ?? '',
            status: 'ACTIVE',
          },
          select: { endsAt: true },
        });
        // Paying a renewal early only records the money; the boundary applies
        // it, otherwise two periods would be ACTIVE at once.
        if (current && current.endsAt <= now) {
          await this.fulfillment.applyRenewal(tx, paidOrder, now);
        }
      }
    } catch (error) {
      // The money is already captured. A failed fulfilment must never roll
      // the transaction back and hide it, otherwise no one can refund it.
      const reason =
        error instanceof AppException ? error.type : 'FULFILLMENT_FAILED';
      if (!(error instanceof AppException)) {
        this.logger.error(
          `Fulfilment failed for paid order ${fresh.number}`,
          error,
        );
      }
      await tx.order.update({
        where: { id: fresh.id },
        data: { failureReason: reason },
      });
      return {
        status: 'FAILED',
        reason,
        orderId: fresh.id,
        paymentId: payment.id,
      };
    }

    // The money is captured and the term is granted (now or at the boundary),
    // so this is the one point where a receipt is both true and useful.
    await this.notifications.enqueuePaymentSucceeded(tx, fresh.id);

    return {
      status: 'PROCESSED',
      reason: null,
      orderId: fresh.id,
      paymentId: payment.id,
    };
  }

  private async recordSuccess(
    tx: Prisma.TransactionClient,
    order: Order,
    parsed: PaymentNotificationPayload,
    now: Date,
    provider: PaymentProvider,
  ): Promise<{ id: string }> {
    const captured = await tx.payment.findFirst({
      where: { orderId: order.id, status: 'SUCCEEDED' },
      select: { id: true },
    });
    if (captured) {
      return captured;
    }

    const attempt = await tx.payment.findFirst({
      where: {
        orderId: order.id,
        status: { in: ['INITIATED', 'PENDING'] },
      },
      orderBy: { initiatedAt: 'desc' },
      select: { id: true },
    });

    const data = {
      status: 'SUCCEEDED' as const,
      successKey: order.id,
      amountCents: order.amountCents,
      currency: order.currency,
      providerTradeNo: parsed.providerTradeNo ?? null,
      buyerId: parsed.buyerId ?? null,
      paidAt: parsed.paidAt ?? now,
    };

    if (attempt) {
      return tx.payment.update({
        where: { id: attempt.id },
        data,
        select: { id: true },
      });
    }

    return tx.payment.create({
      data: {
        orderId: order.id,
        provider,
        ...data,
      },
      select: { id: true },
    });
  }

  private async recordRejected(
    parsed: PaymentNotificationPayload,
    payload: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.prisma.paymentNotification.create({
        data: {
          provider: this.gateway.provider,
          externalId: parsed.externalId || `INVALID-${Date.now()}`,
          verified: false,
          eventType: parsed.eventType,
          payload: payload as Prisma.InputJsonObject,
          status: 'FAILED',
          errorMessage: 'INVALID_SIGNATURE',
          processedAt: new Date(),
        },
      });
    } catch (error) {
      // A replayed invalid callback must not turn into a 500.
      this.logger.warn(
        `Could not store rejected notification: ${this.errorMessage(error)}`,
      );
    }
  }

  private finishNotification(
    tx: Prisma.TransactionClient,
    id: string,
    status: 'PROCESSED' | 'IGNORED' | 'FAILED',
    errorMessage: string | null,
    orderId?: string,
    paymentId?: string,
  ): Promise<unknown> {
    return tx.paymentNotification.update({
      where: { id },
      data: {
        status,
        errorMessage,
        orderId: orderId ?? null,
        paymentId: paymentId ?? null,
        processedAt: new Date(),
      },
    });
  }

  private async loadView(id: string): Promise<OrderView> {
    const row = await this.prisma.order.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!row) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    return toOrderView(row);
  }

  private async loadAdminView(id: string): Promise<AdminOrderView> {
    const row = await this.prisma.order.findUnique({
      where: { id },
      include: ADMIN_ORDER_INCLUDE,
    });
    if (!row) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    return toAdminOrderView(row);
  }

  private publishedVersion(planId: string): Promise<VersionRow | null> {
    return this.prisma.planVersion.findFirst({
      where: { planId, status: 'PUBLISHED' },
      include: VERSION_INCLUDE,
    });
  }

  private isUniqueViolation(error: unknown, field: string): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String(error.meta?.target ?? '').includes(field)
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message.slice(0, 255);
    }
    return String(error).slice(0, 255);
  }
}
