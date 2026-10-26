import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Order } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppException } from '../common/errors/app.exception';
import { AppConfig } from '../config/app-config.service';
import { PaymentGateway } from '../infra/payments/payment-gateway';
import type { PaymentNotificationPayload } from '../infra/payments/payment-gateway';
import { PrismaService } from '../infra/prisma/prisma.service';
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
import type {
  CreateOrderInput,
  CreatePaymentInput,
  RefundOrderInput,
} from './orders.schemas';
import type { CheckoutView, OrderView } from './orders.types';

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

const ORDER_NUMBER_PREFIX = 'ORD';
const RENEWAL_ACTIVE_STATUSES = ['TRIALING', 'ACTIVE'] as const;
/** Provider statuses that mean the money was captured. */
const CAPTURED_EVENTS = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

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
  quantity: row.quantity,
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

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly gateway: PaymentGateway,
    private readonly periods: SubscriptionPeriodsService,
    private readonly fulfillment: OrderFulfillmentService,
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
          quantity: input.quantity,
          unitPriceCents: price.priceCents,
          currency: price.currency,
          amountCents: price.priceCents * input.quantity,
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
    input: CreatePaymentInput,
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

    const provider = input.provider ?? this.gateway.provider;
    if (provider !== this.gateway.provider) {
      throw AppException.unprocessable(
        `Payment provider ${provider} is not configured`,
        'PaymentProviderUnavailable',
      );
    }

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
  ): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true, refunds: true },
    });
    if (!order) {
      throw AppException.notFound('Order not found', 'OrderNotFound');
    }
    if (order.status !== 'PAID' && order.status !== 'FULFILLED') {
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
    if (payment.provider !== this.gateway.provider) {
      throw AppException.conflict(
        `Refunds for ${payment.provider} are not configured`,
        'PaymentProviderUnavailable',
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

      await this.prisma.$transaction([
        this.prisma.refund.update({
          where: { id: refund.id },
          data: {
            status: 'SUCCEEDED',
            providerRefundNo: result.providerRefundNo,
            completedAt: now,
          },
        }),
        ...(reserved + amountCents === payment.amountCents
          ? [
              this.prisma.order.update({
                where: { id: order.id },
                data: { status: 'REFUNDED' },
              }),
            ]
          : []),
      ]);
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

    return this.loadView(order.id);
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
          const quantity = change?.targetQuantity ?? period.quantity ?? 1;
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
              quantity,
              unitPriceCents: price.priceCents,
              currency,
              amountCents: price.priceCents * quantity,
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
        subscription: { status: { in: [...RENEWAL_ACTIVE_STATUSES] } },
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
              subscription.status !== 'ACTIVE')
          ) {
            return 'skipped' as const;
          }

          const period = await this.periods.current(tx, row.subscriptionId);
          if (!period || period.endsAt > now) {
            return 'skipped' as const;
          }

          const paid = await tx.order.findFirst({
            where: { sourcePeriodId: period.id, status: 'PAID' },
          });
          if (paid) {
            await this.fulfillment.applyRenewal(tx, paid, now);
            return 'fulfilled' as const;
          }

          await tx.order.updateMany({
            where: { sourcePeriodId: period.id, status: 'PENDING' },
            data: { status: 'CLOSED', closedAt: now, renewalKey: null },
          });

          const cancellation = await tx.subscriptionChange.findFirst({
            where: {
              subscriptionId: row.subscriptionId,
              status: 'PENDING',
              kind: 'CANCEL',
              effectiveAt: { lte: period.endsAt },
            },
            select: { id: true },
          });
          if (cancellation) {
            await this.periods.close(tx, period, {
              endedAt: period.endsAt,
              closeReason: 'CANCELED',
              grantStatus: 'EXPIRED',
            });
            await tx.subscriptionChange.update({
              where: { id: cancellation.id },
              data: {
                status: 'APPLIED',
                pendingKey: null,
                appliedAt: period.endsAt,
              },
            });
            await tx.subscription.update({
              where: { id: row.subscriptionId },
              data: {
                status: 'CANCELED',
                endedAt: period.endsAt,
                openKey: null,
              },
            });
            return 'canceled' as const;
          }

          await this.periods.close(tx, period, {
            endedAt: period.endsAt,
            closeReason: 'EXPIRED',
            grantStatus: 'EXPIRED',
          });
          await tx.subscriptionChange.updateMany({
            where: { subscriptionId: row.subscriptionId, status: 'PENDING' },
            data: {
              status: 'FAILED',
              pendingKey: null,
              appliedAt: period.endsAt,
              failureReason: 'UNPAID',
            },
          });
          await tx.subscription.update({
            where: { id: row.subscriptionId },
            data: {
              status: 'EXPIRED',
              endedAt: period.endsAt,
              openKey: null,
            },
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

        if (
          parsed.amountCents !== order.amountCents ||
          parsed.currency.toLowerCase() !== order.currency.toLowerCase()
        ) {
          await this.finishNotification(
            tx,
            notification.id,
            'FAILED',
            'AMOUNT_MISMATCH',
            order.id,
          );
          return true;
        }

        await tx.$queryRaw`
          SELECT id FROM \`PaymentOrder\` WHERE id = ${order.id} FOR UPDATE
        `;
        const fresh = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
        });

        if (fresh.status === 'FULFILLED' || fresh.status === 'REFUNDED') {
          await this.finishNotification(
            tx,
            notification.id,
            'PROCESSED',
            'ALREADY_FULFILLED',
            fresh.id,
          );
          return true;
        }
        if (fresh.status === 'CLOSED') {
          await this.finishNotification(
            tx,
            notification.id,
            'FAILED',
            'ORDER_CLOSED',
            fresh.id,
          );
          return true;
        }

        const payment = await this.recordSuccess(tx, fresh, parsed, now);

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
            // Paying a renewal early only records the money; the boundary
            // applies it, otherwise two periods would be ACTIVE at once.
            if (current && current.endsAt <= now) {
              await this.fulfillment.applyRenewal(tx, paidOrder, now);
            }
          }
        } catch (error) {
          if (error instanceof AppException) {
            // The money is real; keep the order PAID and surface the reason
            // for an operator instead of retrying the provider forever.
            await tx.order.update({
              where: { id: fresh.id },
              data: { failureReason: error.type },
            });
            await this.finishNotification(
              tx,
              notification.id,
              'FAILED',
              error.type,
              fresh.id,
              payment.id,
            );
            return true;
          }
          throw error;
        }

        await this.finishNotification(
          tx,
          notification.id,
          'PROCESSED',
          null,
          fresh.id,
          payment.id,
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

  private async recordSuccess(
    tx: Prisma.TransactionClient,
    order: Order,
    parsed: PaymentNotificationPayload,
    now: Date,
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
        provider: this.gateway.provider,
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
