import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  SubscriptionPeriodCloseReason,
  SubscriptionStatus,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { SubscriptionPeriodsService } from './subscription-periods.service';

export interface TerminateSubscriptionParams {
  readonly subscriptionId: string;
  readonly status: Extract<SubscriptionStatus, 'CANCELED' | 'EXPIRED'>;
  readonly closeReason: SubscriptionPeriodCloseReason;
  /** The moment the contract actually ends; may precede the planned endsAt. */
  readonly endedAt: Date;
  readonly now: Date;
  readonly actorUserId?: string | null;
  /** Writes an APPLIED CANCEL intent, used by explicit admin/user actions. */
  readonly recordCancellation?: boolean;
}

/**
 * The one place that ends a subscription.
 *
 * Every terminal path (admin cancel, settlement, refund revocation) must close
 * the running period, release the user × product slot, free device activation
 * slots and drop unpaid drafts in the same transaction. Keeping that list here
 * means a new caller cannot accidentally leave a subscription half-ended.
 */
@Injectable()
export class SubscriptionLifecycleService {
  constructor(private readonly periods: SubscriptionPeriodsService) {}

  /** Releases every live activation slot of a subscription. */
  async deactivateDevices(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    now: Date,
  ): Promise<void> {
    await tx.deviceActivation.updateMany({
      where: { subscriptionId, activeKey: { not: null } },
      data: { activeKey: null, deactivatedAt: now },
    });
  }

  async terminate(
    tx: Prisma.TransactionClient,
    params: TerminateSubscriptionParams,
  ): Promise<void> {
    await this.periods.lock(tx, params.subscriptionId);

    const subscription = await tx.subscription.findUnique({
      where: { id: params.subscriptionId },
      select: { id: true },
    });
    if (!subscription) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }

    const period = await this.periods.current(tx, params.subscriptionId);
    if (period) {
      await this.periods.close(tx, period, {
        endedAt: params.endedAt,
        closeReason: params.closeReason,
      });
    }

    // An unpaid renewal is only a draft; it must not outlive the contract.
    await tx.order.updateMany({
      where: { subscriptionId: params.subscriptionId, status: 'PENDING' },
      data: {
        status: 'CLOSED',
        closedAt: params.now,
        pendingKey: null,
        renewalKey: null,
      },
    });

    await tx.subscriptionChange.updateMany({
      where: { subscriptionId: params.subscriptionId, status: 'PENDING' },
      data: { status: 'CANCELED', pendingKey: null },
    });

    await this.deactivateDevices(tx, params.subscriptionId, params.now);

    await tx.subscription.update({
      where: { id: params.subscriptionId },
      data: {
        status: params.status,
        endedAt: params.endedAt,
        openKey: null,
      },
    });

    if (params.recordCancellation) {
      await tx.subscriptionChange.create({
        data: {
          subscriptionId: params.subscriptionId,
          kind: 'CANCEL',
          status: 'APPLIED',
          effectiveAt: params.endedAt,
          appliedAt: params.now,
          requestedByUserId: params.actorUserId ?? null,
        },
      });
    }
  }
}
