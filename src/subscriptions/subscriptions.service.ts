import { Injectable } from '@nestjs/common';
import { Prisma, type SubscriptionStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import { addDays, addInterval } from './period-math';
import {
  PERIOD_INCLUDE,
  SubscriptionPeriodsService,
  VERSION_INCLUDE,
  isRenewable,
  openKeyFor,
  priceFor,
  type PeriodRow,
  type PeriodTerms,
  type VersionRow,
} from './subscription-periods.service';
import type {
  ChangeSubscriptionInput,
  CreateSubscriptionInput,
  ResumeSubscriptionInput,
} from './subscriptions.schemas';
import type {
  SubscriptionChangeView,
  SubscriptionPeriodView,
  SubscriptionRenewalView,
  SubscriptionView,
} from './subscriptions.types';

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

type ViewRow = Prisma.SubscriptionGetPayload<{ include: typeof VIEW_INCLUDE }>;

interface TargetTerms {
  readonly version: VersionRow;
  readonly terms: PeriodTerms;
}

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

const toFeatures = (
  period: PeriodRow | null,
  status: SubscriptionStatus,
): readonly string[] => {
  // Only a running period of a live subscription grants anything. Paused and
  // closed subscriptions keep their history, but hold no capability: the
  // version's feature list is the whole answer, so there is nothing to revoke.
  if (
    !period ||
    period.status !== 'ACTIVE' ||
    (status !== 'TRIALING' && status !== 'ACTIVE')
  ) {
    return [];
  }

  return period.planVersion.features.map((link) => link.feature.code).sort();
};

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: SubscriptionPeriodsService,
  ) {}

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

  /**
   * Starts a trial. Paid purchases go through the orders module: a paid
   * subscription must not exist before the money does.
   */
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

    const price = priceFor(version, input.interval, input.currency);
    if (!price) {
      throw AppException.unprocessable(
        `This plan is not sold as ${input.interval} in ${input.currency}`,
        'TermNotAvailable',
      );
    }

    if (version.trialDays <= 0) {
      throw AppException.conflict(
        'This plan does not offer a trial',
        'TrialNotAvailable',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
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

        const subscription = await tx.subscription.create({
          data: {
            userId,
            productId: product.id,
            status: 'TRIALING',
            openKey: openKeyFor(userId, product.id),
            startedAt: now,
          },
        });

        await tx.trialRedemption.create({
          data: {
            userId,
            productId: product.id,
            subscriptionId: subscription.id,
            firstRedeemedAt: now,
          },
        });

        await this.periods.createPeriod(tx, {
          subscriptionId: subscription.id,
          sequence: 1,
          version,
          kind: 'TRIAL',
          terms: {
            interval: input.interval,
            quantity: input.quantity,
            unitPriceCents: price.priceCents,
            currency: price.currency,
            // The trial locks the price it will convert at, not just its seats.
            maxActivations: version.trialMaxActivations,
          },
          startsAt: now,
          endsAt: addDays(now, version.trialDays),
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

      const period = await this.periods.current(tx, id);
      if (!period) {
        throw AppException.conflict(
          'The subscription has no running period',
          'SubscriptionNotActive',
        );
      }

      await this.ensureNoPendingChange(tx, id);
      await this.assertNoPaidRenewal(tx, id);
      // An unpaid renewal order priced the old terms; the job recreates it.
      await this.closePendingOrders(tx, id);
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

      await this.assertNoPaidRenewal(tx, id);
      await this.closePendingOrders(tx, id);

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
      const period = await this.periods.current(tx, id);
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
        await tx.subscription.update({
          where: { id },
          data: { status: last.kind === 'TRIAL' ? 'TRIALING' : 'ACTIVE' },
        });
      } else {
        if (last.status === 'ACTIVE') {
          await this.periods.close(tx, last, {
            endedAt: last.endsAt,
            closeReason: 'PAUSED',
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
        const price = priceFor(last.planVersion, interval, currency);
        if (!price) {
          throw AppException.unprocessable(
            `This plan is not sold as ${interval} in ${currency}`,
            'TermNotAvailable',
          );
        }

        await this.periods.createPeriod(tx, {
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

      await this.assertNoPaidRenewal(tx, id);
      await this.closePendingOrders(tx, id);

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
        await this.periods.close(tx, last, {
          endedAt: now,
          closeReason: 'CANCELED',
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

  private async resolveTarget(
    tx: Prisma.TransactionClient,
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
    const price = priceFor(version, interval, currency);
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

  private publishedVersion(
    db: Prisma.TransactionClient,
    planId: string,
  ): Promise<VersionRow | null> {
    return db.planVersion.findFirst({
      where: { planId, status: 'PUBLISHED' },
      include: VERSION_INCLUDE,
    });
  }

  /** Serialises every write path on the subscription row before reading it. */
  private async lockOwned(
    tx: Prisma.TransactionClient,
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
    tx: Prisma.TransactionClient,
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

  /**
   * Once a renewal is paid it cannot be re-priced: the money already bought
   * specific terms, so changing them is a refund decision, not a silent edit.
   */
  private async assertNoPaidRenewal(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<void> {
    const paid = await tx.order.findFirst({
      where: {
        subscriptionId,
        status: 'PAID',
        appliedPeriodId: null,
        sourcePeriod: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (paid) {
      throw AppException.conflict(
        'The current period has already been paid; changes apply after it ends',
        'RenewalAlreadyPaid',
      );
    }
  }

  /** An unpaid renewal/change order is just a draft and may be repriced. */
  private closePendingOrders(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<{ count: number }> {
    return tx.order.updateMany({
      where: { subscriptionId, status: 'PENDING' },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        pendingKey: null,
        renewalKey: null,
      },
    });
  }

  private discardPendingChanges(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<{ count: number }> {
    return tx.subscriptionChange.updateMany({
      where: { subscriptionId, status: 'PENDING' },
      data: { status: 'CANCELED', pendingKey: null },
    });
  }

  private recordAppliedChange(
    tx: Prisma.TransactionClient,
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

  private async loadView(
    db: Prisma.TransactionClient,
    id: string,
  ): Promise<SubscriptionView> {
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
      features: toFeatures(period, row.status),
    };
  }
}
