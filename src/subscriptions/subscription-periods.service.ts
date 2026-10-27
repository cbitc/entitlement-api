import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PlanInterval,
  type SubscriptionPeriodCloseReason,
  type SubscriptionPeriodKind,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';

export const VERSION_INCLUDE = Prisma.validator<Prisma.PlanVersionInclude>()({
  prices: true,
  plan: { select: { id: true, code: true } },
  features: { select: { feature: { select: { code: true } } } },
});

export const PERIOD_INCLUDE =
  Prisma.validator<Prisma.SubscriptionPeriodInclude>()({
    planVersion: { include: VERSION_INCLUDE },
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
 * The only writer of `SubscriptionPeriod`.
 *
 * Both the trial path (subscriptions) and the paid path (orders) go through
 * here, so "one ACTIVE period per subscription" cannot drift between the two
 * entry points. Entitlement is not materialised: a period pins an immutable
 * `PlanVersion`, and that version's `PlanVersionFeature` rows are the grant.
 */
@Injectable()
export class SubscriptionPeriodsService {
  async createPeriod(db: Db, params: CreatePeriodParams): Promise<PeriodRow> {
    return db.subscriptionPeriod.create({
      data: {
        subscriptionId: params.subscriptionId,
        sequence: params.sequence,
        planVersionId: params.version.id,
        kind: params.kind,
        status: 'ACTIVE',
        currentKey: params.subscriptionId,
        interval: params.terms.interval,
        unitPriceCents: params.terms.unitPriceCents,
        currency: params.terms.currency,
        maxActivations: params.terms.maxActivations,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
      },
      include: PERIOD_INCLUDE,
    });
  }

  async close(
    db: Db,
    period: PeriodRow,
    options: {
      readonly endedAt: Date;
      readonly closeReason: SubscriptionPeriodCloseReason;
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
