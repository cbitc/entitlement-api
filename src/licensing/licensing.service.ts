import { Injectable } from '@nestjs/common';
import { Prisma, type SubscriptionStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import {
  pageOf,
  skipFor,
  type Page,
  type Pagination,
} from '../common/http/pagination';
import { PrismaService } from '../infra/prisma/prisma.service';
import { LicenseTokenService } from './license-token.service';
import type { LicenseMachineInput } from './licensing.schemas';
import type {
  AdminLicenseFilter,
  AdminLicenseView,
  LicenseListResponse,
  LicenseTokenView,
  LicenseView,
} from './licensing.types';

/** Only these states grant entitlement; PAUSED is visible but not usable. */
const LIVE_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE'];
/** Non-terminal states whose license (and activations) can still be listed. */
const VISIBLE_STATUSES: readonly SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAUSED',
];

const LICENSE_INCLUDE = Prisma.validator<Prisma.SubscriptionInclude>()({
  product: { select: { code: true } },
  periods: {
    where: { status: 'ACTIVE' },
    orderBy: { sequence: 'desc' },
    take: 1,
    include: {
      planVersion: {
        select: {
          plan: { select: { code: true } },
          features: { select: { feature: { select: { code: true } } } },
        },
      },
    },
  },
  activations: {
    where: { activeKey: { not: null } },
    orderBy: { activatedAt: 'asc' },
    select: {
      id: true,
      machineId: true,
      activatedAt: true,
      lastRefreshedAt: true,
    },
  },
});

type LicenseRow = Prisma.SubscriptionGetPayload<{
  include: typeof LICENSE_INCLUDE;
}>;

/** The admin projection adds the owner; nothing else about the license changes. */
const ADMIN_LICENSE_INCLUDE = Prisma.validator<Prisma.SubscriptionInclude>()({
  ...LICENSE_INCLUDE,
  user: { select: { id: true, email: true } },
});

type AdminLicenseRow = Prisma.SubscriptionGetPayload<{
  include: typeof ADMIN_LICENSE_INCLUDE;
}>;

type LicensePeriod = LicenseRow['periods'][number];

/** The period's pinned version is the grant: its feature rows are the answer. */
const featureCodes = (period: LicensePeriod | undefined): readonly string[] =>
  period?.planVersion.features.map((link) => link.feature.code).sort() ?? [];

const activeKeyFor = (subscriptionId: string, machineId: string): string =>
  `${subscriptionId}:${machineId}`;

const noActiveSubscription = (): AppException =>
  AppException.notFound(
    'No active subscription covers this product',
    'NoActiveSubscription',
  );

const toActivationView = (
  activation: LicenseRow['activations'][number],
): LicenseView['activations'][number] => ({
  id: activation.id,
  machineId: activation.machineId,
  activatedAt: activation.activatedAt.toISOString(),
  lastRefreshedAt: activation.lastRefreshedAt.toISOString(),
});

/**
 * The licence is a projection of the subscription, never a row of its own.
 *
 * `Subscription` + its ACTIVE `SubscriptionPeriod` + the immutable
 * `PlanVersion` that period pinned already answer "who may use which features
 * until when", so the only new state is which machines hold a slot.
 */
@Injectable()
export class LicensingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: LicenseTokenService,
  ) {}

  async obtain(
    userId: string,
    input: LicenseMachineInput,
    offline = false,
    now: Date = new Date(),
  ): Promise<LicenseTokenView> {
    const resolved = await this.prisma.$transaction(async (tx) => {
      const candidate = await this.findSubscription(
        tx,
        userId,
        input.product,
        LIVE_STATUSES,
      );
      if (!candidate) {
        throw noActiveSubscription();
      }

      // Serialise obtains for one subscription so two new devices cannot both
      // pass the slot count and overshoot `maxActivations`.
      await tx.$queryRaw`
        SELECT id FROM \`Subscription\` WHERE id = ${candidate.id} FOR UPDATE
      `;

      const row = await tx.subscription.findUnique({
        where: { id: candidate.id },
        include: LICENSE_INCLUDE,
      });
      if (!row) {
        throw noActiveSubscription();
      }

      const period = this.assertLicensable(row, now);
      const activeKey = activeKeyFor(row.id, input.machineId);

      const existing = await tx.deviceActivation.findUnique({
        where: { activeKey },
        select: { id: true },
      });
      if (existing) {
        await tx.deviceActivation.update({
          where: { id: existing.id },
          data: { lastRefreshedAt: now },
        });
      } else {
        const used = await tx.deviceActivation.count({
          where: { subscriptionId: row.id, activeKey: { not: null } },
        });
        if (used >= period.maxActivations) {
          throw AppException.conflict(
            'The activation limit for this subscription has been reached',
            'ActivationLimitExceeded',
          );
        }
        await tx.deviceActivation.create({
          data: {
            subscriptionId: row.id,
            machineId: input.machineId,
            activeKey,
            activatedAt: now,
            lastRefreshedAt: now,
          },
        });
      }

      return {
        product: row.product.code,
        plan: period.planVersion.plan.code,
        trial: period.kind === 'TRIAL',
        features: featureCodes(period),
        periodEndsAt: period.endsAt,
      };
    });

    const issued = await this.tokens.issue(
      {
        userId,
        product: resolved.product,
        plan: resolved.plan,
        trial: resolved.trial,
        features: resolved.features,
        machineId: input.machineId,
        offline,
        expiresAt: resolved.periodEndsAt,
      },
      now,
    );

    return {
      token: issued.token,
      plan: resolved.plan,
      trial: resolved.trial,
      features: resolved.features,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  async deactivate(
    userId: string,
    input: LicenseMachineInput,
    now: Date = new Date(),
  ): Promise<void> {
    const subscription = await this.findSubscription(
      this.prisma,
      userId,
      input.product,
      VISIBLE_STATUSES,
    );
    if (!subscription) {
      throw AppException.notFound(
        'No license matches this product',
        'LicenseNotFound',
      );
    }

    const result = await this.prisma.deviceActivation.updateMany({
      where: {
        subscriptionId: subscription.id,
        activeKey: activeKeyFor(subscription.id, input.machineId),
      },
      data: { activeKey: null, deactivatedAt: now },
    });
    if (result.count === 0) {
      throw AppException.notFound(
        'No activation exists for this machine',
        'ActivationNotFound',
      );
    }
  }

  async listForUser(userId: string): Promise<LicenseListResponse> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        userId,
        status: { in: [...VISIBLE_STATUSES] },
        openKey: { not: null },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: LICENSE_INCLUDE,
    });

    return {
      licenses: rows.filter(isVisibleLicense).map(toLicenseView),
    };
  }

  async adminList(
    filter: AdminLicenseFilter,
    pagination: Pagination,
    now: Date = new Date(),
  ): Promise<Page<AdminLicenseView>> {
    const userId = await this.resolveAdminUser(filter);
    const where: Prisma.SubscriptionWhereInput = {
      ...(userId ? { userId } : {}),
      ...(filter.product ? { product: { code: filter.product } } : {}),
      status: { in: [...VISIBLE_STATUSES] },
      openKey: { not: null },
      // Ends the license the moment its period does, without post-filtering
      // a page (which would make `total` lie).
      periods: { some: { status: 'ACTIVE', endsAt: { gt: now } } },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.subscription.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.limit,
        include: ADMIN_LICENSE_INCLUDE,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    return pageOf(rows.map(toAdminLicenseView), total, pagination);
  }

  /** Support unbinding: the user lost a machine and cannot release the slot. */
  async deactivateAsAdmin(
    activationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const activation = await this.prisma.deviceActivation.findUnique({
      where: { id: activationId },
      select: { id: true, activeKey: true },
    });
    if (!activation || !activation.activeKey) {
      throw AppException.notFound(
        'No active activation matches this id',
        'ActivationNotFound',
      );
    }

    await this.prisma.deviceActivation.update({
      where: { id: activationId },
      data: { activeKey: null, deactivatedAt: now },
    });
  }

  private async resolveAdminUser(
    filter: AdminLicenseFilter,
  ): Promise<string | undefined> {
    if (filter.userId) {
      return filter.userId;
    }
    if (!filter.email) {
      return undefined;
    }

    const user = await this.prisma.user.findUnique({
      where: { email: filter.email },
      select: { id: true },
    });
    if (!user) {
      throw AppException.notFound('User not found', 'UserNotFound');
    }
    return user.id;
  }

  private findSubscription(
    db: Prisma.TransactionClient,
    userId: string,
    productCode: string,
    statuses: readonly SubscriptionStatus[],
  ): Promise<{ id: string } | null> {
    return db.subscription.findFirst({
      where: {
        userId,
        product: { code: productCode },
        status: { in: [...statuses] },
        openKey: { not: null },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }

  private assertLicensable(row: LicenseRow, now: Date): LicensePeriod {
    const period = row.periods[0];
    if (
      !period ||
      (row.status !== 'TRIALING' && row.status !== 'ACTIVE') ||
      now.getTime() < period.startsAt.getTime() ||
      now.getTime() >= period.endsAt.getTime()
    ) {
      throw noActiveSubscription();
    }
    return period;
  }
}

const toLicenseView = (row: LicenseRow): LicenseView => {
  const period = row.periods[0];
  return {
    product: row.product.code,
    plan: period?.planVersion.plan.code ?? '',
    trial: period?.kind === 'TRIAL',
    status: row.status,
    periodStart: period?.startsAt.toISOString() ?? null,
    periodEnd: period?.endsAt.toISOString() ?? null,
    maxActivations: period?.maxActivations ?? 0,
    features: featureCodes(period),
    activations: row.activations.map(toActivationView),
  };
};

const toAdminLicenseView = (row: AdminLicenseRow): AdminLicenseView => ({
  ...toLicenseView(row),
  userId: row.user.id,
  userEmail: row.user.email,
});

/**
 * An ended period is history, not a license the caller still holds. Paused
 * subscriptions stay visible so the user can see what is suspended.
 */
const isVisibleLicense = (row: LicenseRow): boolean => {
  const period = row.periods[0];
  return period !== undefined && period.endsAt.getTime() > Date.now();
};
