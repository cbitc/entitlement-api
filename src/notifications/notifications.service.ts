import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type NotificationType,
  type OutboundNotification,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import {
  pageOf,
  skipFor,
  type Page,
  type Pagination,
} from '../common/http/pagination';
import { AppConfig } from '../config/app-config.service';
import { Clock } from '../infra/clock/clock';
import { Mailer } from '../infra/mail/mailer';
import { PrismaService } from '../infra/prisma/prisma.service';
import { renderNotification } from './templates';
import type {
  AdminNotificationFilter,
  AdminNotificationView,
  DispatchResult,
  PaymentSucceededPayload,
  RefundIssuedPayload,
  SubscriptionExpiredPayload,
  TemplateContext,
} from './notifications.types';

/** A send that has not reported back within this window is considered dead. */
const STALE_SENDING_MS = 5 * 60_000;
/** Retry delays grow from one minute up to one hour. */
const MAX_BACKOFF_MS = 60 * 60_000;

const toView = (row: OutboundNotification): AdminNotificationView => ({
  id: row.id,
  userId: row.userId,
  email: row.email,
  type: row.type,
  status: row.status,
  subject: row.subject,
  payload: row.payload,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  sentAt: row.sentAt?.toISOString() ?? null,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Transactional outbox for customer mail.
 *
 * Enqueueing happens inside the caller's transaction: a captured payment and
 * its receipt are written together, so neither can exist without the other.
 * Delivery is a separate pass that can fail, back off and be replayed without
 * touching the business state that produced the message.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** Receipt for a captured payment, whether new or a renewal. */
  async enqueuePaymentSucceeded(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        kind: true,
        userId: true,
        subscriptionId: true,
        amountCents: true,
        currency: true,
        interval: true,
        paidAt: true,
        appliedPeriodId: true,
        product: { select: { displayName: true } },
        planVersion: { select: { plan: { select: { displayName: true } } } },
        user: { select: { email: true } },
      },
    });
    if (!order) {
      return;
    }

    let startsAt: string | null = null;
    let endsAt: string | null = null;

    if (order.appliedPeriodId) {
      const period = await tx.subscriptionPeriod.findUnique({
        where: { id: order.appliedPeriodId },
        select: { startsAt: true, endsAt: true },
      });
      if (period) {
        endsAt = period.endsAt.toISOString();
        // A new purchase starts now; a renewal that has already been applied
        // starts at the boundary, which the receipt should name.
        startsAt =
          order.kind === 'NEW_SUBSCRIPTION'
            ? null
            : period.startsAt.toISOString();
      }
    } else if (order.subscriptionId) {
      // Renewal paid early: the next period is only opened at the boundary.
      const current = await tx.subscriptionPeriod.findFirst({
        where: { subscriptionId: order.subscriptionId, status: 'ACTIVE' },
        select: { endsAt: true },
      });
      startsAt = current?.endsAt.toISOString() ?? null;
    }

    const payload: PaymentSucceededPayload = {
      orderId: order.id,
      orderNumber: order.number,
      productName: order.product.displayName,
      planName: order.planVersion.plan.displayName,
      interval: order.interval,
      amountCents: order.amountCents,
      currency: order.currency,
      paidAt: (order.paidAt ?? this.clock.now()).toISOString(),
      startsAt,
      endsAt,
    };

    await this.enqueue(tx, {
      userId: order.userId,
      email: order.user.email,
      type: 'PAYMENT_SUCCEEDED',
      payload,
      // One receipt per order, even if a callback is replayed.
      dedupeKey: `payment:${order.id}`,
    });
  }

  /** A subscription that ran out of time without a paid renewal. */
  async enqueueSubscriptionExpired(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    endedAt: Date,
  ): Promise<void> {
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        user: { select: { email: true } },
        product: { select: { displayName: true } },
        periods: {
          orderBy: { sequence: 'desc' },
          take: 1,
          select: {
            closeReason: true,
            planVersion: {
              select: { plan: { select: { displayName: true } } },
            },
          },
        },
      },
    });
    if (!subscription) {
      return;
    }

    const latest = subscription.periods[0];
    const payload: SubscriptionExpiredPayload = {
      subscriptionId: subscription.id,
      productName: subscription.product.displayName,
      planName: latest?.planVersion.plan.displayName ?? '',
      endedAt: endedAt.toISOString(),
      paused: latest?.closeReason === 'PAUSED',
    };

    await this.enqueue(tx, {
      userId: subscription.userId,
      email: subscription.user.email,
      type: 'SUBSCRIPTION_EXPIRED',
      payload,
      dedupeKey: `expired:${subscription.id}`,
    });
  }

  /** Confirmation that money has been returned. */
  async enqueueRefundSucceeded(
    tx: Prisma.TransactionClient,
    refundId: string,
  ): Promise<void> {
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        amountCents: true,
        currency: true,
        reason: true,
        completedAt: true,
        order: {
          select: {
            id: true,
            number: true,
            userId: true,
            user: { select: { email: true } },
          },
        },
      },
    });
    if (!refund) {
      return;
    }

    const payload: RefundIssuedPayload = {
      orderId: refund.order.id,
      orderNumber: refund.order.number,
      amountCents: refund.amountCents,
      currency: refund.currency,
      reason: refund.reason,
      completedAt: (refund.completedAt ?? this.clock.now()).toISOString(),
    };

    await this.enqueue(tx, {
      userId: refund.order.userId,
      email: refund.order.user.email,
      type: 'REFUND_ISSUED',
      payload,
      dedupeKey: `refund:${refund.id}`,
    });
  }

  /**
   * Delivers due rows. Claiming is a compare-and-set on PENDING, so two
   * processes may look at the same batch but only one sends each message.
   */
  async dispatch(now: Date, limit: number): Promise<DispatchResult> {
    await this.reclaimStale(now);

    const rows = await this.prisma.outboundNotification.findMany({
      where: {
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const row of rows) {
      const claimed = await this.prisma.outboundNotification.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'SENDING',
          claimedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        continue;
      }

      const attempts = row.attempts + 1;

      try {
        const rendered = renderNotification(
          row.type,
          row.payload,
          this.templateContext(),
        );
        await this.mailer.sendMail({
          to: row.email,
          subject: row.subject,
          text: rendered.text,
          html: rendered.html,
        });
        await this.prisma.outboundNotification.updateMany({
          where: { id: row.id, status: 'SENDING' },
          data: {
            status: 'SENT',
            sentAt: now,
            claimedAt: null,
            nextAttemptAt: null,
            lastError: null,
          },
        });
        sent += 1;
      } catch (error) {
        const message = this.errorMessage(error);
        const exhausted = attempts >= this.config.notifications.maxAttempts;

        await this.prisma.outboundNotification.updateMany({
          where: { id: row.id, status: 'SENDING' },
          data: exhausted
            ? {
                status: 'FAILED',
                claimedAt: null,
                nextAttemptAt: null,
                lastError: message,
              }
            : {
                status: 'PENDING',
                claimedAt: null,
                nextAttemptAt: this.backoffFrom(now, attempts),
                lastError: message,
              },
        });

        if (exhausted) {
          failed += 1;
          this.logger.error(
            { err: error, notificationId: row.id, type: row.type, attempts },
            'Notification failed permanently',
          );
        } else {
          retried += 1;
          this.logger.warn(
            { err: error, notificationId: row.id, type: row.type, attempts },
            'Notification delivery failed; retry scheduled',
          );
        }
      }
    }

    return { sent, retried, failed };
  }

  async listPaged(
    filter: AdminNotificationFilter,
    pagination: Pagination,
  ): Promise<Page<AdminNotificationView>> {
    const where: Prisma.OutboundNotificationWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.email ? { email: { contains: filter.email } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.outboundNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(pagination),
        take: pagination.limit,
      }),
      this.prisma.outboundNotification.count({ where }),
    ]);

    return pageOf(rows.map(toView), total, pagination);
  }

  /** Puts a terminal or stuck row back in the queue for an operator. */
  async resend(id: string): Promise<AdminNotificationView> {
    const result = await this.prisma.outboundNotification.updateMany({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
        claimedAt: null,
        sentAt: null,
        lastError: null,
      },
    });
    if (result.count === 0) {
      throw AppException.notFound(
        'Notification not found',
        'NotificationNotFound',
      );
    }

    const row = await this.prisma.outboundNotification.findUniqueOrThrow({
      where: { id },
    });
    return toView(row);
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    input: {
      readonly userId: string;
      readonly email: string;
      readonly type: NotificationType;
      readonly payload: unknown;
      readonly dedupeKey: string;
    },
  ): Promise<void> {
    const subject = renderNotification(
      input.type,
      input.payload,
      this.templateContext(),
    ).subject.slice(0, 200);

    await tx.outboundNotification.createMany({
      data: [
        {
          userId: input.userId,
          email: input.email,
          type: input.type,
          subject,
          payload: input.payload as unknown as Prisma.InputJsonValue,
          dedupeKey: input.dedupeKey,
        },
      ],
      // A replayed callback or a retried job must not send twice.
      skipDuplicates: true,
    });
  }

  private async reclaimStale(now: Date): Promise<void> {
    await this.prisma.outboundNotification.updateMany({
      where: {
        status: 'SENDING',
        claimedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) },
      },
      data: { status: 'PENDING', claimedAt: null },
    });
  }

  private backoffFrom(now: Date, attempts: number): Date {
    const delay = Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
    return new Date(now.getTime() + delay);
  }

  private templateContext(): TemplateContext {
    return {
      appName: this.config.appName,
      webUrl: this.config.notifications.webAppUrl,
      timeZone: this.config.notifications.timeZone,
    };
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 255);
  }
}
