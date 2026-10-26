import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type EntitlementGrantStatus,
  type PlanInterval,
  type SubscriptionPeriodCloseReason,
  type SubscriptionPeriodKind,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import { addDays, addInterval } from './period-math';
import type {
  ChangeSubscriptionInput,
  CreateSubscriptionInput,
  ResumeSubscriptionInput,
} from './subscriptions.schemas';
import type {
  SubscriptionChangeView,
  SubscriptionEntitlementView,
  SubscriptionPeriodView,
  SubscriptionRenewalView,
  SubscriptionView,
} from './subscriptions.types';

const VERSION_INCLUDE = Prisma.validator<Prisma.PlanVersionInclude>()({
  prices: true,
  plan: { select: { id: true, code: true } },
  features: { include: { feature: true } },
});

const PERIOD_INCLUDE = Prisma.validator<Prisma.SubscriptionPeriodInclude>()({
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

const VIEW_INCLUDE = Prisma.validator<Prisma.SubscriptionInclude>()({
  product: { select: { code: true } },
  periods: {
    orderBy: { sequence: 'desc' },
    take: 1,
    include: PERIOD_INCLUDE,
  },
  changes: {
    where: { status: 'PENDING' },
    take: 1,
    include: {
      targetPlanVersion: {
        select: {
          id: true,
          version: true,
          plan: { select: { code: true } },
        },
      },
    },
  },
});

type Db = Prisma.TransactionClient;
type VersionRow = Prisma.PlanVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;
type PeriodRow = Prisma.SubscriptionPeriodGetPayload<{
  include: typeof PERIOD_INCLUDE;
}>;
type ViewRow = Prisma.SubscriptionGetPayload<{ include: typeof VIEW_INCLUDE }>;

interface PeriodTerms {
  readonly interval: PlanInterval;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly maxActivations: number;
}

interface CreatePeriodParams {
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly version: VersionRow;
  readonly kind: SubscriptionPeriodKind;
  readonly terms: PeriodTerms;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

interface TargetTerms {
  readonly version: VersionRow;
  readonly terms: PeriodTerms;
}

/** CLOSED_FOR_SALE still renews; only RETIRED stops the next period. */
const isRenewable = (status: string): boolean =>
  status === 'PUBLISHED' || status === 'CLOSED_FOR_SALE';

/** Only a live subscription may hold the user × product slot. */
const openKeyFor = (userId: string, productId: string): string =>
  `${userId}:${productId}`;

const toPeriodView = (period: PeriodRow): SubscriptionPeriodView => ({
  id: period.id,
  sequence: period.sequence,
  kind: period.kind,
  planCode: period.planVersion.plan.code,
  planVersionId: period.planVersionId,
  version: period.planVersion.version,
  interval: period.interval,
  quantity: period.quantity,
  unitPriceCents: period.unitPriceCents,
  currency: period.currency,
  maxActivations: period.maxActivations,
  startsAt: period.startsAt.toISOString(),
  endsAt: period.endsAt.toISOString(),
  endedAt: period.endedAt?.toISOString() ?? null,
  closeReason: period.closeReason,
});

const toRenewalView = (
  pending: ViewRow['changes'][number] | null,
  period: SubscriptionPeriodView | null,
): SubscriptionRenewalView | null => {
  if (pending) {
    // A pending cancellation means nothing will renew.
    if (pending.kind !== 'CHANGE') {
      return null;
    }
    return {
      source: 'CHANGE',
      planCode: pending.targetPlanVersion?.plan.code ?? period?.planCode ?? '',
      version: pending.targetPlanVersion?.version ?? period?.version ?? 0,
      interval: pending.targetInterval ?? period?.interval ?? null,
      quantity: pending.targetQuantity ?? period?.quantity ?? null,
      effectiveAt: pending.effectiveAt.toISOString(),
    };
  }

  if (!period) {
    return null;
  }

  return {
    source: 'PERIOD',
    planCode: period.planCode,
    version: period.version,
    interval: period.interval,
    quantity: period.quantity,
    effectiveAt: period.endsAt,
  };
};

const toChangeView = (
  change: ViewRow['changes'][number],
): SubscriptionChangeView => ({
  id: change.id,
  kind: change.kind,
  effectiveAt: change.effectiveAt.toISOString(),
  planCode: change.targetPlanVersion?.plan.code ?? null,
  version: change.targetPlanVersion?.version ?? null,
  interval: change.targetInterval,
  quantity: change.targetQuantity,
});

const toEntitlements = (
  period: PeriodRow | null,
): readonly SubscriptionEntitlementView[] => {
  const items = period?.grant?.items ?? [];
  return items.map((item) => ({
    code: item.feature.code,
    value: item.value,
    limit: item.limit,
    used: item.used,
    remaining: item.limit === null ? null : Math.max(0, item.limit - item.used),
  }));
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.prisma.subscription.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });

    return Promise.all(rows.map((row) => this.loadView(this.prisma, row.id)));
  }

  async getForUser(userId: string, id: string): Promise<SubscriptionView> {
    const owned = await this.prisma.subscription.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }

    return this.loadView(this.prisma, id);
  }

  async create(
    userId: string,
    input: CreateSubscriptionInput,
    now = new Date(),
  ): Promise<SubscriptionView> {
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

    const version = await this.publishedVersion(this.prisma, plan.id);
    if (!version) {
      throw AppException.conflict(
        'This plan is not for sale',
        'PlanNotSellable',
      );
    }

    const price = this.priceFor(version, input.interval, input.currency);
    if (!price) {
      throw AppException.unprocessable(
        `This plan is not sold as ${input.interval} in ${input.currency}`,
        'TermNotAvailable',
      );
    }

    if (input.trial && version.trialDays <= 0) {
      throw AppException.conflict(
        'This plan does not offer a trial',
        'TrialNotAvailable',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.trial) {
          const redeemed = await tx.trialRedemption.findUnique({
            where: { userId_productId: { userId, productId: product.id } },
            select: { userId: true },
          });
          if (redeemed) {
            throw AppException.conflict(
              'The trial has already been used for this product',
              'TrialAlreadyUsed',
            );
          }
        }

        const subscription = await tx.subscription.create({
          data: {
            userId,
            productId: product.id,
            status: input.trial ? 'TRIALING' : 'ACTIVE',
            openKey: openKeyFor(userId, product.id),
            startedAt: now,
          },
        });

        if (input.trial) {
          await tx.trialRedemption.create({
            data: {
              userId,
              productId: product.id,
              subscriptionId: subscription.id,
              firstRedeemedAt: now,
            },
          });
        }

        await this.createPeriodWithGrant(tx, {
          subscriptionId: subscription.id,
          sequence: 1,
          version,
          kind: input.trial ? 'TRIAL' : 'PAID',
          terms: {
            interval: input.interval,
            quantity: input.quantity,
            unitPriceCents: price.priceCents,
            currency: price.currency,
            // The trial locks the price it will convert at, not just its seats.
            maxActivations: input.trial
              ? version.trialMaxActivations
              : version.maxActivations,
          },
          startsAt: now,
          endsAt: input.trial
            ? addDays(now, version.trialDays)
            : addInterval(now, input.interval),
        });

        return this.loadView(tx, subscription.id);
      });
    } catch (error) {
      throw this.mapStartConflict(error);
    }
  }

  /**
   * Records the intent only. The target version and terms are frozen now and
   * applied by the renewal run at `effectiveAt` — never mid-period.
   */
  async change(
    userId: string,
    id: string,
    input: ChangeSubscriptionInput,
  ): Promise<SubscriptionView> {
    return this.prisma.$transaction(async (tx) => {
      const subscription = await this.lockOwned(tx, userId, id);
      if (
        subscription.status !== 'TRIALING' &&
        subscription.status !== 'ACTIVE'
      ) {
        throw AppException.conflict(
          'The subscription is not active',
          'SubscriptionNotActive',
        );
      }

      const period = await this.currentPeriod(tx, id);
      if (!period) {
        throw AppException.conflict(
          'The subscription has no running period',
          'SubscriptionNotActive',
        );
      }

      await this.ensureNoPendingChange(tx, id);
      const target = await this.resolveTarget(
        tx,
        subscription.productId,
        period,
        input,
      );

      await tx.subscriptionChange.create({
        data: {
          subscriptionId: id,
          kind: 'CHANGE',
          status: 'PENDING',
          targetPlanVersionId: target.version.id,
          targetInterval: target.terms.interval,
          targetQuantity: target.terms.quantity,
          effectiveAt: period.endsAt,
          pendingKey: id,
          requestedByUserId: userId,
        },
      });

      return this.loadView(tx, id);
    });
  }

  async cancelChange(
    userId: string,
    id: string,
    changeId: string,
  ): Promise<SubscriptionView> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOwned(tx, userId, id);

      const change = await tx.subscriptionChange.findFirst({
        where: { id: changeId, subscriptionId: id, status: 'PENDING' },
        select: { id: true },
      });
      if (!change) {
        throw AppException.notFound(
          'Scheduled change not found',
          'ChangeNotFound',
        );
      }

      await tx.subscriptionChange.update({
        where: { id: changeId },
        data: { status: 'CANCELED', pendingKey: null },
      });

      return this.loadView(tx, id);
    });
  }

  /**
   * Pausing is a state action, not a commercial one: it suspends the grant but
   * keeps the period clock running, so resuming before `endsAt` loses no time.
   */
  async pause(userId: string, id: string): Promise<SubscriptionView> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const subscription = await this.lockOwned(tx, userId, id);
      if (
        subscription.status !== 'TRIALING' &&
        subscription.status !== 'ACTIVE'
      ) {
        throw AppException.conflict(
          'Only a running subscription can be paused',
          'SubscriptionNotActive',
        );
      }

      await this.ensureNoPendingChange(tx, id);
      const period = await this.currentPeriod(tx, id);
      if (!period) {
        throw AppException.conflict(
          'The subscription has no running period',
          'SubscriptionNotActive',
        );
      }

      await tx.subscription.update({
        where: { id },
        data: { status: 'PAUSED' },
      });
      if (period.grant?.status === 'ACTIVE') {
        await tx.entitlementGrant.update({
          where: { id: period.grant.id },
          data: { status: 'SUSPENDED' },
        });
      }
      await this.recordAppliedChange(tx, id, 'PAUSE', userId, now);

      return this.loadView(tx, id);
    });
  }

  async resume(
    userId: string,
    id: string,
    input: ResumeSubscriptionInput = {},
  ): Promise<SubscriptionView> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.lockOwned(tx, userId, id);
      const last = await tx.subscriptionPeriod.findFirst({
        where: { subscriptionId: id },
        orderBy: { sequence: 'desc' },
        include: PERIOD_INCLUDE,
      });
      if (!last) {
        throw AppException.conflict(
          'The subscription has no period to resume',
          'SubscriptionNotActive',
        );
      }

      if (last.status === 'ACTIVE' && last.endsAt > now) {
        if (last.grant?.status === 'SUSPENDED') {
          await tx.entitlementGrant.update({
            where: { id: last.grant.id },
            data: { status: 'ACTIVE' },
          });
        }
        await tx.subscription.update({
          where: { id },
          data: { status: last.kind === 'TRIAL' ? 'TRIALING' : 'ACTIVE' },
        });
      } else {
        if (last.status === 'ACTIVE') {
          await this.closePeriod(tx, last, {
            endedAt: last.endsAt,
            closeReason: 'PAUSED',
            grantStatus: 'EXPIRED',
          });
        }
        if (!isRenewable(last.planVersion.status)) {
          throw AppException.conflict(
            'That version can no longer be renewed; change the plan first',
            'VersionNotRenewable',
          );
        }

        const interval = input.interval ?? last.interval;
        if (!interval) {
          throw AppException.unprocessable(
            'A billing interval is required to resume after the period ended',
            'TermRequired',
          );
        }
        const currency = last.currency ?? 'cny';
        const price = this.priceFor(last.planVersion, interval, currency);
        if (!price) {
          throw AppException.unprocessable(
            `This plan is not sold as ${interval} in ${currency}`,
            'TermNotAvailable',
          );
        }

        await this.createPeriodWithGrant(tx, {
          subscriptionId: id,
          sequence: last.sequence + 1,
          version: last.planVersion,
          kind: 'PAID',
          terms: {
            interval,
            quantity: last.quantity ?? 1,
            unitPriceCents: price.priceCents,
            currency,
            maxActivations: last.planVersion.maxActivations,
          },
          startsAt: now,
          endsAt: addInterval(now, interval),
        });
        await tx.subscription.update({
          where: { id },
          data: { status: 'ACTIVE' },
        });
      }

      await this.recordAppliedChange(tx, id, 'RESUME', userId, now);

      return this.loadView(tx, id);
    });
  }

  /** Cancelling always stops at the end of the paid term, never immediately. */
  async cancel(userId: string, id: string): Promise<SubscriptionView> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const subscription = await this.lockOwned(tx, userId, id);
      if (
        subscription.status === 'CANCELED' ||
        subscription.status === 'EXPIRED'
      ) {
        throw AppException.conflict(
          'The subscription has already ended',
          'SubscriptionNotActive',
        );
      }

      const last = await tx.subscriptionPeriod.findFirst({
        where: { subscriptionId: id },
        orderBy: { sequence: 'desc' },
        include: PERIOD_INCLUDE,
      });

      if (last?.status === 'ACTIVE' && last.endsAt > now) {
        await this.discardPendingChanges(tx, id);
        await tx.subscriptionChange.create({
          data: {
            subscriptionId: id,
            kind: 'CANCEL',
            status: 'PENDING',
            effectiveAt: last.endsAt,
            pendingKey: id,
            requestedByUserId: userId,
          },
        });
        return this.loadView(tx, id);
      }

      if (last?.status === 'ACTIVE') {
        await this.closePeriod(tx, last, {
          endedAt: now,
          closeReason: 'CANCELED',
          grantStatus: 'EXPIRED',
        });
      }
      await this.discardPendingChanges(tx, id);
      await this.recordAppliedChange(tx, id, 'CANCEL', userId, now);
      await tx.subscription.update({
        where: { id },
        data: { status: 'CANCELED', endedAt: now, openKey: null },
      });

      return this.loadView(tx, id);
    });
  }

  /**
   * Renewal driver. Returns counts instead of throwing so one bad subscription
   * cannot stop the batch; the caller (a cron job) decides how to alarm.
   */
  async renewDueSubscriptions(
    now = new Date(),
    limit = 200,
  ): Promise<{ renewed: number; failed: number }> {
    const due = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['TRIALING', 'ACTIVE'] },
        periods: { some: { status: 'ACTIVE', endsAt: { lte: now } } },
      },
      select: { id: true },
      take: limit,
    });

    let renewed = 0;
    let failed = 0;

    for (const row of due) {
      try {
        if (await this.renewOne(row.id, now)) {
          renewed += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.error(`Renewal failed for subscription ${row.id}`, error);
      }
    }

    return { renewed, failed };
  }

  private async renewOne(id: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findUnique({
        where: { id },
      });
      if (
        !subscription ||
        (subscription.status !== 'TRIALING' && subscription.status !== 'ACTIVE')
      ) {
        return false;
      }

      const period = await this.currentPeriod(tx, id);
      if (!period || period.endsAt > now) {
        return false;
      }

      const pending = await tx.subscriptionChange.findFirst({
        where: {
          subscriptionId: id,
          status: 'PENDING',
          effectiveAt: { lte: now },
        },
        include: { targetPlanVersion: { include: VERSION_INCLUDE } },
      });

      if (pending?.kind === 'CANCEL') {
        await this.closePeriod(tx, period, {
          endedAt: period.endsAt,
          closeReason: 'CANCELED',
          grantStatus: 'EXPIRED',
        });
        await tx.subscriptionChange.update({
          where: { id: pending.id },
          data: {
            status: 'APPLIED',
            pendingKey: null,
            appliedAt: period.endsAt,
          },
        });
        await tx.subscription.update({
          where: { id },
          data: {
            status: 'CANCELED',
            endedAt: period.endsAt,
            openKey: null,
          },
        });
        return true;
      }

      // Price protection: renew on the pinned version unless an intent says
      // otherwise. Never look up the latest PUBLISHED version here.
      let version = period.planVersion;
      let interval = period.interval;
      let quantity = period.quantity ?? 1;
      let applyingChangeId: string | null = null;

      if (pending?.kind === 'CHANGE') {
        const target = pending.targetPlanVersion ?? period.planVersion;
        const targetInterval = pending.targetInterval ?? interval;
        const targetPrice = targetInterval
          ? this.priceFor(target, targetInterval, period.currency ?? 'cny')
          : null;

        if (isRenewable(target.status) && targetInterval && targetPrice) {
          version = target;
          interval = targetInterval;
          quantity = pending.targetQuantity ?? quantity;
          applyingChangeId = pending.id;
        } else {
          // The deal agreed to no longer exists: record that, then renew the
          // current terms rather than silently swapping in something else.
          await tx.subscriptionChange.update({
            where: { id: pending.id },
            data: {
              status: 'FAILED',
              pendingKey: null,
              appliedAt: period.endsAt,
              failureReason: isRenewable(target.status)
                ? 'TERM_NOT_AVAILABLE'
                : 'VERSION_RETIRED',
            },
          });
        }
      }

      const currency = period.currency ?? 'cny';
      const price = interval
        ? this.priceFor(version, interval, currency)
        : null;

      if (!isRenewable(version.status) || !interval || !price) {
        await this.closePeriod(tx, period, {
          endedAt: period.endsAt,
          closeReason: 'EXPIRED',
          grantStatus: 'EXPIRED',
        });
        await tx.subscription.update({
          where: { id },
          data: { status: 'EXPIRED', endedAt: period.endsAt, openKey: null },
        });
        return true;
      }

      await this.closePeriod(tx, period, {
        endedAt: period.endsAt,
        closeReason: 'RENEWED',
        grantStatus: 'EXPIRED',
      });

      const next = await this.createPeriodWithGrant(tx, {
        subscriptionId: id,
        sequence: period.sequence + 1,
        version,
        kind: 'PAID',
        terms: {
          interval,
          quantity,
          unitPriceCents: price.priceCents,
          currency,
          maxActivations: version.maxActivations,
        },
        startsAt: period.endsAt,
        endsAt: addInterval(period.endsAt, interval),
      });

      if (applyingChangeId) {
        await tx.subscriptionChange.update({
          where: { id: applyingChangeId },
          data: {
            status: 'APPLIED',
            pendingKey: null,
            appliedAt: period.endsAt,
            appliedPeriodId: next.id,
          },
        });
      }

      await tx.subscription.update({
        where: { id },
        data: { status: 'ACTIVE' },
      });

      return true;
    });
  }

  private async createPeriodWithGrant(
    tx: Db,
    params: CreatePeriodParams,
  ): Promise<PeriodRow> {
    const period = await tx.subscriptionPeriod.create({
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

    await tx.entitlementGrant.create({
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

  private async closePeriod(
    tx: Db,
    period: PeriodRow,
    options: {
      readonly endedAt: Date;
      readonly closeReason: SubscriptionPeriodCloseReason;
      readonly grantStatus: EntitlementGrantStatus;
    },
  ): Promise<void> {
    await tx.subscriptionPeriod.update({
      where: { id: period.id },
      data: {
        status: 'CLOSED',
        currentKey: null,
        endedAt: options.endedAt,
        closeReason: options.closeReason,
      },
    });

    if (period.grant) {
      await tx.entitlementGrant.update({
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

  private async resolveTarget(
    tx: Db,
    productId: string,
    period: PeriodRow,
    input: ChangeSubscriptionInput,
  ): Promise<TargetTerms> {
    let version: VersionRow;

    if (input.planCode === undefined) {
      if (!isRenewable(period.planVersion.status)) {
        throw AppException.conflict(
          'The current version can no longer be changed',
          'VersionNotRenewable',
        );
      }
      version = period.planVersion;
    } else {
      const plan = await tx.plan.findUnique({
        where: { productId_code: { productId, code: input.planCode } },
        select: { id: true },
      });
      if (!plan) {
        throw AppException.notFound(
          `Unknown plan "${input.planCode}"`,
          'PlanNotFound',
        );
      }

      const published = await this.publishedVersion(tx, plan.id);
      if (!published) {
        throw AppException.conflict(
          'That plan is not for sale',
          'PlanNotSellable',
        );
      }
      version = published;
    }

    const interval = input.interval ?? period.interval;
    if (!interval) {
      throw AppException.unprocessable(
        'A billing interval is required for this change',
        'TermRequired',
      );
    }

    const quantity = input.quantity ?? period.quantity ?? 1;
    const currency = period.currency ?? 'cny';
    const price = this.priceFor(version, interval, currency);
    if (!price) {
      throw AppException.unprocessable(
        `That plan is not sold as ${interval} in ${currency}`,
        'TermNotAvailable',
      );
    }

    return {
      version,
      terms: {
        interval,
        quantity,
        unitPriceCents: price.priceCents,
        currency,
        maxActivations: version.maxActivations,
      },
    };
  }

  private publishedVersion(db: Db, planId: string): Promise<VersionRow | null> {
    return db.planVersion.findFirst({
      where: { planId, status: 'PUBLISHED' },
      include: VERSION_INCLUDE,
    });
  }

  private priceFor(
    version: VersionRow,
    interval: PlanInterval,
    currency: string,
  ): { readonly priceCents: number; readonly currency: string } | null {
    return (
      version.prices.find(
        (candidate) =>
          candidate.interval === interval && candidate.currency === currency,
      ) ?? null
    );
  }

  private currentPeriod(
    db: Db,
    subscriptionId: string,
  ): Promise<PeriodRow | null> {
    return db.subscriptionPeriod.findFirst({
      where: { subscriptionId, status: 'ACTIVE' },
      include: PERIOD_INCLUDE,
    });
  }

  /** Serialises every write path on the subscription row before reading it. */
  private async lockOwned(
    tx: Db,
    userId: string,
    id: string,
  ): Promise<{ id: string; productId: string; status: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`Subscription\` WHERE id = ${id} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }

    const subscription = await tx.subscription.findFirst({
      where: { id, userId },
      select: { id: true, productId: true, status: true },
    });
    if (!subscription) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }

    return subscription;
  }

  private async ensureNoPendingChange(
    tx: Db,
    subscriptionId: string,
  ): Promise<void> {
    const pending = await tx.subscriptionChange.findFirst({
      where: { subscriptionId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) {
      throw AppException.conflict(
        'A change is already scheduled for this subscription',
        'ChangeAlreadyPending',
      );
    }
  }

  private discardPendingChanges(
    tx: Db,
    subscriptionId: string,
  ): Promise<{ count: number }> {
    return tx.subscriptionChange.updateMany({
      where: { subscriptionId, status: 'PENDING' },
      data: { status: 'CANCELED', pendingKey: null },
    });
  }

  private recordAppliedChange(
    tx: Db,
    subscriptionId: string,
    kind: 'PAUSE' | 'RESUME' | 'CANCEL',
    userId: string,
    now: Date,
  ): Promise<unknown> {
    return tx.subscriptionChange.create({
      data: {
        subscriptionId,
        kind,
        status: 'APPLIED',
        effectiveAt: now,
        requestedByUserId: userId,
        appliedAt: now,
      },
    });
  }

  private mapStartConflict(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }
    if (error.code !== 'P2002') {
      return error;
    }

    const target = String(error.meta?.target ?? '');
    if (target.includes('openKey')) {
      return AppException.conflict(
        'An active subscription to this product already exists',
        'SubscriptionAlreadyActive',
      );
    }
    return AppException.conflict(
      'The trial has already been used for this product',
      'TrialAlreadyUsed',
    );
  }

  private async loadView(db: Db, id: string): Promise<SubscriptionView> {
    const row = await db.subscription.findUnique({
      where: { id },
      include: VIEW_INCLUDE,
    });
    if (!row) {
      throw AppException.notFound(
        'Subscription not found',
        'SubscriptionNotFound',
      );
    }

    return this.toView(row);
  }

  private toView(row: ViewRow): SubscriptionView {
    const period = row.periods[0] ?? null;
    const pending = row.changes[0] ?? null;
    const currentPeriod = period ? toPeriodView(period) : null;

    return {
      id: row.id,
      productCode: row.product.code,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      currentPeriod,
      renewal: toRenewalView(pending, currentPeriod),
      pendingChange: pending ? toChangeView(pending) : null,
      entitlements: toEntitlements(period),
    };
  }
}
