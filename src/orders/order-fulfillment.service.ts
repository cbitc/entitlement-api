import { Injectable } from '@nestjs/common';
import { Prisma, type Order } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { addInterval } from '../subscriptions/period-math';
import {
  SubscriptionPeriodsService,
  VERSION_INCLUDE,
  openKeyFor,
} from '../subscriptions/subscription-periods.service';

/**
 * Turns a paid order into a subscription period.
 *
 * Kept separate from `OrdersService` so both the callback path (new purchase,
 * immediate) and the settlement path (renewal, at the boundary) share exactly
 * one implementation of "what a paid order grants".
 */
@Injectable()
export class OrderFulfillmentService {
  constructor(private readonly periods: SubscriptionPeriodsService) {}

  /** First purchase: the subscription does not exist before the money does. */
  async applyNewSubscription(
    tx: Prisma.TransactionClient,
    order: Order,
    now: Date,
  ): Promise<string> {
    const version = await tx.planVersion.findUniqueOrThrow({
      where: { id: order.planVersionId },
      include: VERSION_INCLUDE,
    });

    const subscription = await tx.subscription.create({
      data: {
        userId: order.userId,
        productId: order.productId,
        status: 'ACTIVE',
        openKey: openKeyFor(order.userId, order.productId),
        startedAt: now,
      },
    });

    const period = await this.periods.createWithGrant(tx, {
      subscriptionId: subscription.id,
      sequence: 1,
      version,
      kind: 'PAID',
      terms: {
        interval: order.interval,
        quantity: order.quantity,
        unitPriceCents: order.unitPriceCents,
        currency: order.currency,
        maxActivations: version.maxActivations,
      },
      startsAt: now,
      endsAt: addInterval(now, order.interval),
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'FULFILLED',
        subscriptionId: subscription.id,
        appliedPeriodId: period.id,
        fulfilledAt: now,
        pendingKey: null,
      },
    });

    return period.id;
  }

  /**
   * Renewal/trial conversion: opens the next period at the boundary it bought.
   *
   * Called only once the source period has ended, so the one-ACTIVE-period
   * invariant is never violated by paying early.
   */
  async applyRenewal(
    tx: Prisma.TransactionClient,
    order: Order,
    now: Date,
  ): Promise<string> {
    if (!order.subscriptionId || !order.sourcePeriodId) {
      throw AppException.conflict(
        'The renewal order lost its subscription',
        'RenewalTargetChanged',
      );
    }

    const current = await this.periods.current(tx, order.subscriptionId);
    if (!current || current.id !== order.sourcePeriodId) {
      throw AppException.conflict(
        'The renewal order no longer matches the running period',
        'RenewalTargetChanged',
      );
    }

    const version = await tx.planVersion.findUniqueOrThrow({
      where: { id: order.planVersionId },
      include: VERSION_INCLUDE,
    });

    await this.periods.close(tx, current, {
      endedAt: current.endsAt,
      closeReason: 'RENEWED',
      grantStatus: 'EXPIRED',
    });

    const next = await this.periods.createWithGrant(tx, {
      subscriptionId: order.subscriptionId,
      sequence: current.sequence + 1,
      version,
      kind: 'PAID',
      terms: {
        interval: order.interval,
        quantity: order.quantity,
        unitPriceCents: order.unitPriceCents,
        currency: order.currency,
        maxActivations: version.maxActivations,
      },
      startsAt: current.endsAt,
      endsAt: addInterval(current.endsAt, order.interval),
    });

    if (order.changeId) {
      await tx.subscriptionChange.update({
        where: { id: order.changeId },
        data: {
          status: 'APPLIED',
          pendingKey: null,
          appliedAt: current.endsAt,
          appliedPeriodId: next.id,
        },
      });
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'FULFILLED',
        appliedPeriodId: next.id,
        fulfilledAt: now,
        renewalKey: null,
      },
    });

    await tx.subscription.update({
      where: { id: order.subscriptionId },
      data: { status: 'ACTIVE' },
    });

    return next.id;
  }
}
