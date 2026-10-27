import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SubscriptionStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import { LicenseTokenService } from './license-token.service';
import type { LicenseMachineInput } from './licensing.schemas';
import type {
  AdminLicenseListResponse,
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
      planVersion: { select: { plan: { select: { code: true } } } },
      grant: {
        select: {
          id: true,
          status: true,
          effectiveAt: true,
          expiresAt: true,
        },
      },
    },
  },
  activations: {
    where: { activeKey: { not: null } },
    orderBy: { activatedAt: 'asc' },
    select: {
      machineId: true,
      activatedAt: true,
      lastRefreshedAt: true,
    },
  },
});

type LicenseRow = Prisma.SubscriptionGetPayload<{
  include: typeof LICENSE_INCLUDE;
}>;

type LicensePeriod = LicenseRow['periods'][number];
type LicenseGrant = NonNullable<LicensePeriod['grant']>;

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
  machineId: activation.machineId,
  activatedAt: activation.activatedAt.toISOString(),
  lastRefreshedAt: activation.lastRefreshedAt.toISOString(),
});

/**
 * The licence is a projection of the subscription, never a row of its own.
 *
 * `Subscription` + its ACTIVE `SubscriptionPeriod` + the period's
 * `EntitlementGrant` already answer "who may use which edition until when", so
 * the only new state is which machines hold an activation slot.
 */
@Injectable()
export class LicensingService {
  private readonly logger = new Logger(LicensingService.name);

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

      const { period, grant } = this.assertLicensable(row, now);
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
        grantExpiresAt: grant.expiresAt,
      };
    });

    const issued = await this.tokens.issue(
      {
        userId,
        product: resolved.product,
        plan: resolved.plan,
        trial: resolved.trial,
        machineId: input.machineId,
        offline,
        expiresAt: resolved.grantExpiresAt,
      },
      now,
    );

    return {
      token: issued.token,
      plan: resolved.plan,
      trial: resolved.trial,
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

  async adminList(email: string): Promise<AdminLicenseListResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });
    if (!user) {
      throw AppException.notFound('User not found', 'UserNotFound');
    }

    const rows = await this.prisma.subscription.findMany({
      where: {
        userId: user.id,
        status: { in: [...VISIBLE_STATUSES] },
        openKey: { not: null },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: LICENSE_INCLUDE,
    });

    return {
      email: user.email,
      licenses: rows.filter(isVisibleLicense).map(toLicenseView),
    };
  }

  /**
   * Break-glass revocation: the entitlement is withdrawn but the contract is
   * left alone. The next period creates a fresh grant, so this is not a
   * substitute for cancelling the subscription.
   */
  async adminRevoke(
    actorUserId: string,
    email: string,
    product: string,
    now: Date = new Date(),
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      throw AppException.notFound('User not found', 'UserNotFound');
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: user.id,
        product: { code: product },
        status: { in: [...VISIBLE_STATUSES] },
        openKey: { not: null },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!subscription) {
      throw AppException.notFound(
        'No license matches this email and product',
        'LicenseNotFound',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM \`Subscription\` WHERE id = ${subscription.id} FOR UPDATE
      `;

      const period = await tx.subscriptionPeriod.findFirst({
        where: { subscriptionId: subscription.id, status: 'ACTIVE' },
        orderBy: { sequence: 'desc' },
        select: {
          id: true,
          grant: { select: { id: true, status: true } },
        },
      });
      if (
        !period?.grant ||
        (period.grant.status !== 'ACTIVE' &&
          period.grant.status !== 'SUSPENDED')
      ) {
        throw AppException.notFound(
          'No revocable license exists for this product',
          'LicenseNotFound',
        );
      }

      await tx.entitlementGrant.update({
        where: { id: period.grant.id },
        data: {
          status: 'REVOKED',
          activeKey: null,
          closedAt: now,
        },
      });
      await tx.deviceActivation.updateMany({
        where: { subscriptionId: subscription.id, activeKey: { not: null } },
        data: { activeKey: null, deactivatedAt: now },
      });
    });

    this.logger.warn(
      `License revoked by ${actorUserId} for ${email}/${product}`,
    );
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

  private assertLicensable(
    row: LicenseRow,
    now: Date,
  ): { period: LicensePeriod; grant: LicenseGrant } {
    const period = row.periods[0];
    const grant = period?.grant;
    if (
      !period ||
      !grant ||
      grant.status !== 'ACTIVE' ||
      (row.status !== 'TRIALING' && row.status !== 'ACTIVE') ||
      now.getTime() < grant.effectiveAt.getTime() ||
      now.getTime() >= grant.expiresAt.getTime()
    ) {
      throw noActiveSubscription();
    }
    return { period, grant };
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
    activations: row.activations.map(toActivationView),
  };
};

/**
 * A revoked or expired grant is history, not a license the caller still holds.
 * Paused subscriptions stay visible so the user can see what is suspended.
 */
const isVisibleLicense = (row: LicenseRow): boolean => {
  const grant = row.periods[0]?.grant;
  return grant?.status === 'ACTIVE' || grant?.status === 'SUSPENDED';
};
