import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type EntitlementGrantStatus,
  type PlanInterval,
  type SubscriptionPeriodCloseReason,
  type SubscriptionPeriodKind,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';

export const VERSION_INCLUDE = Prisma.validator<Prisma.PlanVersionInclude>()({
  prices: true,
  plan: { select: { id: true, code: true } },
  features: { include: { feature: true } },
});

export const PERIOD_INCLUDE =
  Prisma.validator<Prisma.SubscriptionPeriodInclude>()({
    planVersion: { include: VERSION_INCLUDE },
    grant: {
      select: {
        id: true,
        status: true,
        items: {
          select: {
            value: true,
            limit: true,
            used: true,
            feature: { select: { code: true } },
          },
        },
      },
    },
  });

export type Db = Prisma.TransactionClient;
export type VersionRow = Prisma.PlanVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;
export type PeriodRow = Prisma.SubscriptionPeriodGetPayload<{
  include: typeof PERIOD_INCLUDE;
}>;

export interface PeriodTerms {
  readonly interval: PlanInterval;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly maxActivations: number;
}

export interface CreatePeriodParams {
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly version: VersionRow;
  readonly kind: SubscriptionPeriodKind;
  readonly terms: PeriodTerms;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** CLOSED_FOR_SALE still renews; only RETIRED stops the next period. */
export const isRenewable = (status: string): boolean =>
  status === 'PUBLISHED' || status === 'CLOSED_FOR_SALE';

/** Only a live subscription may hold the user × product slot. */
export const openKeyFor = (userId: string, productId: string): string =>
  `${userId}:${productId}`;

export const priceFor = (
  version: VersionRow,
  interval: PlanInterval,
  currency: string,
): { readonly priceCents: number; readonly currency: string } | null =>
  version.prices.find(
    (candidate) =>
      candidate.interval === interval && candidate.currency === currency,
  ) ?? null;

/**
 * The only writer of `SubscriptionPeriod` and its grant.
 *
 * Both the trial path (subscriptions) and the paid path (orders) go through
 * here, so "one ACTIVE period per subscription" and "grant mirrors period"
 * cannot drift between the two entry points.
 */
@Injectable()
export class SubscriptionPeriodsService {
  async createWithGrant(
    db: Db,
    params: CreatePeriodParams,
  ): Promise<PeriodRow> {
    const period = await db.subscriptionPeriod.create({
      data: {
        subscriptionId: params.subscriptionId,
        sequence: params.sequence,
        planVersionId: params.version.id,
        kind: params.kind,
        status: 'ACTIVE',
        currentKey: params.subscriptionId,
        interval: params.terms.interval,
        quantity: params.terms.quantity,
        unitPriceCents: params.terms.unitPriceCents,
        currency: params.terms.currency,
        maxActivations: params.terms.maxActivations,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
      },
      include: PERIOD_INCLUDE,
    });

    await db.entitlementGrant.create({
      data: {
        subscriptionId: params.subscriptionId,
        subscriptionPeriodId: period.id,
        planVersionId: params.version.id,
        status: 'ACTIVE',
        activeKey: params.subscriptionId,
        effectiveAt: params.startsAt,
        expiresAt: params.endsAt,
        items: {
          create: params.version.features.map((link) => ({
            feature: { connect: { id: link.featureId } },
            // Stored JSON is never a database NULL, only a JSON value.
            value: link.value as Prisma.InputJsonValue,
            valueType: link.feature.valueType,
            consumable: link.feature.consumable,
            limit:
              link.feature.consumable && typeof link.value === 'number'
                ? link.value
                : null,
          })),
        },
      },
    });

    return period;
  }

  async close(
    db: Db,
    period: PeriodRow,
    options: {
      readonly endedAt: Date;
      readonly closeReason: SubscriptionPeriodCloseReason;
      readonly grantStatus: EntitlementGrantStatus;
    },
  ): Promise<void> {
    await db.subscriptionPeriod.update({
      where: { id: period.id },
      data: {
        status: 'CLOSED',
        currentKey: null,
        endedAt: options.endedAt,
        closeReason: options.closeReason,
      },
    });

    if (period.grant) {
      await db.entitlementGrant.update({
        where: { id: period.grant.id },
        data: {
          status: options.grantStatus,
          activeKey: null,
          closedAt: options.endedAt,
          expiresAt: options.endedAt,
        },
      });
    }
  }

  current(db: Db, subscriptionId: string): Promise<PeriodRow | null> {
    return db.subscriptionPeriod.findFirst({
      where: { subscriptionId, status: 'ACTIVE' },
      include: PERIOD_INCLUDE,
    });
  }

  /** Row-level lock shared by every subscription write path. */
  async lock(db: Db, subscriptionId: string): Promise<void> {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`Subscription\` WHERE id = ${subscriptionId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }
  }
}
