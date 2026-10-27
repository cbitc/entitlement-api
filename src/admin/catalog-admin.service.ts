import { Injectable } from '@nestjs/common';
import { Prisma, type PlanVersionStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import type {
  AdminCreateFeatureInput,
  AdminCreatePlanInput,
  AdminCreateProductInput,
  AdminCreateVersionInput,
  AdminUpdatePlanInput,
  AdminUpdateProductInput,
  AdminUpdateVersionInput,
} from './admin.schemas';
import type {
  AdminFeatureView,
  AdminPlanView,
  AdminPriceView,
  AdminProductView,
  AdminVersionView,
} from './admin.types';

const VERSION_INCLUDE = Prisma.validator<Prisma.PlanVersionInclude>()({
  prices: { orderBy: [{ interval: 'asc' }, { currency: 'asc' }] },
  features: { include: { feature: { select: { code: true } } } },
});

const PRODUCT_INCLUDE = Prisma.validator<Prisma.ProductInclude>()({
  plans: {
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    include: {
      versions: {
        orderBy: { version: 'desc' },
        include: VERSION_INCLUDE,
      },
    },
  },
});

type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;
type PlanRow = ProductRow['plans'][number];
type VersionRow = Prisma.PlanVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;

const toStringArray = (value: Prisma.JsonValue | null): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const toVersionView = (version: VersionRow): AdminVersionView => ({
  id: version.id,
  version: version.version,
  status: version.status,
  maxActivations: version.maxActivations,
  trialDays: version.trialDays,
  trialMaxActivations: version.trialMaxActivations,
  publishedAt: version.publishedAt?.toISOString() ?? null,
  saleClosedAt: version.saleClosedAt?.toISOString() ?? null,
  retiredAt: version.retiredAt?.toISOString() ?? null,
  prices: version.prices.map((price): AdminPriceView => ({
    interval: price.interval,
    currency: price.currency,
    priceCents: price.priceCents,
  })),
  features: version.features.map((link) => link.feature.code).sort(),
  createdAt: version.createdAt.toISOString(),
});

const toPlanView = (plan: PlanRow): AdminPlanView => ({
  id: plan.id,
  code: plan.code,
  displayName: plan.displayName,
  description: plan.description,
  sortOrder: plan.sortOrder,
  versions: plan.versions.map(toVersionView),
});

const toProductView = (product: ProductRow): AdminProductView => ({
  id: product.id,
  code: product.code,
  displayName: product.displayName,
  description: product.description,
  vendor: product.vendor,
  websiteUrl: product.websiteUrl,
  iconUrl: product.iconUrl,
  tags: toStringArray(product.tags),
  sortOrder: product.sortOrder,
  active: product.active,
  plans: product.plans.map(toPlanView),
});

const toFeatureView = (feature: {
  id: string;
  code: string;
  displayName: string;
  description: string | null;
  createdAt: Date;
}): AdminFeatureView => ({
  id: feature.id,
  code: feature.code,
  displayName: feature.displayName,
  description: feature.description,
  createdAt: feature.createdAt.toISOString(),
});

const isUniqueViolation = (error: unknown, field: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  String(error.meta?.target ?? '').includes(field);

const assertUniquePriceTerms = (prices: readonly AdminPriceView[]): void => {
  const seen = new Set<string>();
  for (const price of prices) {
    const key = `${price.interval}:${price.currency.toLowerCase()}`;
    if (seen.has(key)) {
      throw AppException.unprocessable(
        `Duplicate price for ${price.interval} ${price.currency}`,
        'DuplicatePrice',
      );
    }
    seen.add(key);
  }
};

/**
 * The only writer of catalogue content.
 *
 * Read paths (the shop) stay in `CatalogService`; everything that mutates a
 * plan version lives here, because a version is the unit of commercial truth
 * and every transition has to be checked against the same rules.
 */
@Injectable()
export class CatalogAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(): Promise<AdminProductView[]> {
    const rows = await this.prisma.product.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: PRODUCT_INCLUDE,
    });
    return rows.map(toProductView);
  }

  async createProduct(
    input: AdminCreateProductInput,
  ): Promise<AdminProductView> {
    try {
      const row = await this.prisma.product.create({
        data: {
          code: input.code,
          displayName: input.displayName,
          description: input.description ?? null,
          vendor: input.vendor ?? null,
          websiteUrl: input.websiteUrl ?? null,
          iconUrl: input.iconUrl ?? null,
          tags: input.tags ?? [],
          sortOrder: input.sortOrder ?? 0,
          active: input.active ?? true,
        },
        include: PRODUCT_INCLUDE,
      });
      return toProductView(row);
    } catch (error) {
      if (isUniqueViolation(error, 'code')) {
        throw AppException.conflict(
          'A product with this code already exists',
          'ProductCodeTaken',
        );
      }
      throw error;
    }
  }

  async updateProduct(
    id: string,
    input: AdminUpdateProductInput,
  ): Promise<AdminProductView> {
    await this.requireProduct(id);
    const row = await this.prisma.product.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
        ...(input.websiteUrl !== undefined
          ? { websiteUrl: input.websiteUrl }
          : {}),
        ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: PRODUCT_INCLUDE,
    });
    return toProductView(row);
  }

  async createPlan(
    productId: string,
    input: AdminCreatePlanInput,
  ): Promise<AdminPlanView> {
    await this.requireProduct(productId);
    try {
      const row = await this.prisma.plan.create({
        data: {
          productId,
          code: input.code,
          displayName: input.displayName,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        include: { versions: { include: VERSION_INCLUDE } },
      });
      return toPlanView(row);
    } catch (error) {
      if (isUniqueViolation(error, 'code')) {
        throw AppException.conflict(
          'This product already has a plan with that code',
          'PlanCodeTaken',
        );
      }
      throw error;
    }
  }

  /** Identity and shop presentation only; content belongs to a version. */
  async updatePlan(
    id: string,
    input: AdminUpdatePlanInput,
  ): Promise<AdminPlanView> {
    await this.requirePlan(id);
    const row = await this.prisma.plan.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
      },
      include: { versions: { include: VERSION_INCLUDE } },
    });
    return toPlanView(row);
  }

  async listVersions(planId: string): Promise<AdminVersionView[]> {
    await this.requirePlan(planId);
    const rows = await this.prisma.planVersion.findMany({
      where: { planId },
      orderBy: { version: 'desc' },
      include: VERSION_INCLUDE,
    });
    return rows.map(toVersionView);
  }

  async createVersion(
    planId: string,
    input: AdminCreateVersionInput,
  ): Promise<AdminVersionView> {
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);

      const source = input.copyFromVersionId
        ? await tx.planVersion.findUnique({
            where: { id: input.copyFromVersionId },
            include: VERSION_INCLUDE,
          })
        : null;
      if (input.copyFromVersionId && (!source || source.planId !== planId)) {
        throw AppException.notFound(
          'No such version exists for this plan',
          'VersionNotFound',
        );
      }

      const prices: AdminPriceView[] =
        input.prices ??
        source?.prices.map((price) => ({
          interval: price.interval,
          currency: price.currency,
          priceCents: price.priceCents,
        })) ??
        [];
      assertUniquePriceTerms(prices);

      const featureIds = input.features
        ? await resolveFeatureIds(tx, input.features)
        : (source?.features.map((link) => link.featureId) ?? []);

      const last = await tx.planVersion.findFirst({
        where: { planId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const created = await tx.planVersion.create({
        data: {
          planId,
          version: (last?.version ?? 0) + 1,
          status: 'DRAFT',
          maxActivations: input.maxActivations ?? source?.maxActivations ?? 1,
          trialDays: input.trialDays ?? source?.trialDays ?? 0,
          trialMaxActivations:
            input.trialMaxActivations ?? source?.trialMaxActivations ?? 1,
          prices: {
            create: prices.map((price) => ({
              interval: price.interval,
              currency: price.currency.toLowerCase(),
              priceCents: price.priceCents,
            })),
          },
          features: { create: featureIds.map((featureId) => ({ featureId })) },
        },
        include: VERSION_INCLUDE,
      });
      return toVersionView(created);
    });
  }

  async updateVersion(
    id: string,
    input: AdminUpdateVersionInput,
  ): Promise<AdminVersionView> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.planVersion.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!version) {
        throw AppException.notFound('Version not found', 'VersionNotFound');
      }
      if (version.status !== 'DRAFT') {
        throw AppException.conflict(
          'Only a draft version can be edited',
          'VersionNotEditable',
        );
      }

      if (input.prices) {
        assertUniquePriceTerms(input.prices);
        await tx.planVersionPrice.deleteMany({ where: { planVersionId: id } });
        await tx.planVersionPrice.createMany({
          data: input.prices.map((price) => ({
            planVersionId: id,
            interval: price.interval,
            currency: price.currency.toLowerCase(),
            priceCents: price.priceCents,
          })),
        });
      }

      if (input.features) {
        const featureIds = await resolveFeatureIds(tx, input.features);
        await tx.planVersionFeature.deleteMany({
          where: { planVersionId: id },
        });
        if (featureIds.length > 0) {
          await tx.planVersionFeature.createMany({
            data: featureIds.map((featureId) => ({
              planVersionId: id,
              featureId,
            })),
          });
        }
      }

      const updated = await tx.planVersion.update({
        where: { id },
        data: {
          ...(input.maxActivations !== undefined
            ? { maxActivations: input.maxActivations }
            : {}),
          ...(input.trialDays !== undefined
            ? { trialDays: input.trialDays }
            : {}),
          ...(input.trialMaxActivations !== undefined
            ? { trialMaxActivations: input.trialMaxActivations }
            : {}),
        },
        include: VERSION_INCLUDE,
      });
      return toVersionView(updated);
    });
  }

  /**
   * Publishing closes the previous PUBLISHED version instead of editing it, so
   * existing subscribers keep the terms they bought. The plan row is locked so
   * two concurrent publishes cannot both believe they are first.
   */
  async publishVersion(
    id: string,
    now = new Date(),
  ): Promise<AdminVersionView> {
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.planVersion.findUnique({
        where: { id },
        select: { planId: true },
      });
      if (!initial) {
        throw AppException.notFound('Version not found', 'VersionNotFound');
      }
      await lockPlan(tx, initial.planId);

      const version = await tx.planVersion.findUniqueOrThrow({
        where: { id },
        select: { status: true, _count: { select: { prices: true } } },
      });
      if (version.status !== 'DRAFT') {
        throw AppException.conflict(
          'Only a draft version can be published',
          'VersionNotPublishable',
        );
      }
      if (version._count.prices === 0) {
        throw AppException.unprocessable(
          'A version needs at least one price before it can be published',
          'VersionNotPublishable',
        );
      }

      await tx.planVersion.updateMany({
        where: { planId: initial.planId, status: 'PUBLISHED' },
        data: {
          status: 'CLOSED_FOR_SALE',
          publishedKey: null,
          saleClosedAt: now,
        },
      });
      const published = await tx.planVersion.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedKey: initial.planId,
          publishedAt: now,
        },
        include: VERSION_INCLUDE,
      });
      return toVersionView(published);
    });
  }

  /** No new subscribers, but existing ones keep renewing at these terms. */
  async closeForSale(id: string, now = new Date()): Promise<AdminVersionView> {
    await this.requireStatus(id, 'PUBLISHED', 'close for sale');
    const updated = await this.prisma.planVersion.update({
      where: { id },
      data: {
        status: 'CLOSED_FOR_SALE',
        publishedKey: null,
        saleClosedAt: now,
      },
      include: VERSION_INCLUDE,
    });
    return toVersionView(updated);
  }

  async retireVersion(id: string, now = new Date()): Promise<AdminVersionView> {
    await this.requireStatus(id, 'CLOSED_FOR_SALE', 'retire');
    const updated = await this.prisma.planVersion.update({
      where: { id },
      data: { status: 'RETIRED', retiredAt: now },
      include: VERSION_INCLUDE,
    });
    return toVersionView(updated);
  }

  /** Only a draft with no commercial history can be removed. */
  async deleteVersion(id: string): Promise<void> {
    const version = await this.prisma.planVersion.findUnique({
      where: { id },
      select: {
        status: true,
        _count: {
          select: { periods: true, orders: true, scheduledChanges: true },
        },
      },
    });
    if (!version) {
      throw AppException.notFound('Version not found', 'VersionNotFound');
    }
    if (version.status !== 'DRAFT') {
      throw AppException.conflict(
        'Only a draft version can be deleted',
        'VersionNotEditable',
      );
    }
    const references =
      version._count.periods +
      version._count.orders +
      version._count.scheduledChanges;
    if (references > 0) {
      throw AppException.conflict(
        'This version is referenced by a subscription or an order',
        'VersionInUse',
      );
    }

    await this.prisma.planVersion.delete({ where: { id } });
  }

  async listFeatures(): Promise<AdminFeatureView[]> {
    const rows = await this.prisma.feature.findMany({
      orderBy: { code: 'asc' },
    });
    return rows.map(toFeatureView);
  }

  async createFeature(
    input: AdminCreateFeatureInput,
  ): Promise<AdminFeatureView> {
    try {
      const row = await this.prisma.feature.create({
        data: {
          code: input.code,
          displayName: input.displayName,
          description: input.description ?? null,
        },
      });
      return toFeatureView(row);
    } catch (error) {
      if (isUniqueViolation(error, 'code')) {
        throw AppException.conflict(
          'A feature with this code already exists',
          'FeatureCodeTaken',
        );
      }
      throw error;
    }
  }

  private async requireProduct(id: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!product) {
      throw AppException.notFound('Product not found', 'ProductNotFound');
    }
  }

  private async requirePlan(id: string): Promise<void> {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!plan) {
      throw AppException.notFound('Plan not found', 'PlanNotFound');
    }
  }

  private async requireStatus(
    id: string,
    expected: PlanVersionStatus,
    action: string,
  ): Promise<void> {
    const version = await this.prisma.planVersion.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!version) {
      throw AppException.notFound('Version not found', 'VersionNotFound');
    }
    if (version.status !== expected) {
      throw AppException.conflict(
        `Only a ${expected} version can ${action}`,
        'InvalidVersionTransition',
      );
    }
  }
}

/** Serialises publishes for one plan; the version row alone is not enough. */
const lockPlan = async (
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<void> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM \`Plan\` WHERE id = ${planId} FOR UPDATE
  `;
  if (rows.length === 0) {
    throw AppException.notFound('Plan not found', 'PlanNotFound');
  }
};

const resolveFeatureIds = async (
  tx: Prisma.TransactionClient,
  codes: readonly string[],
): Promise<string[]> => {
  const unique = [...new Set(codes)];
  if (unique.length === 0) {
    return [];
  }

  const found = await tx.feature.findMany({
    where: { code: { in: unique } },
    select: { id: true, code: true },
  });
  if (found.length !== unique.length) {
    const missing = unique.filter(
      (code) => !found.some((row) => row.code === code),
    );
    throw AppException.unprocessable(
      `Unknown features: ${missing.join(', ')}`,
      'UnknownFeature',
    );
  }

  return found.map((row) => row.id);
};
