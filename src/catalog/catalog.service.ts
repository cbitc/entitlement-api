import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import type {
  CatalogPlan,
  CatalogProduct,
  CatalogResponse,
} from './catalog.types';

const VERSION_INCLUDE = Prisma.validator<Prisma.PlanVersionInclude>()({
  prices: { orderBy: [{ interval: 'asc' }, { currency: 'asc' }] },
  features: { include: { feature: true } },
});

type PlanRow = Prisma.PlanGetPayload<{
  include: { versions: { include: typeof VERSION_INCLUDE } };
}>;

type ProductRow = Prisma.ProductGetPayload<{
  include: {
    plans: { include: { versions: { include: typeof VERSION_INCLUDE } } };
  };
}>;

/** The only version that is still being sold. */
const SELLABLE_VERSION = {
  status: 'PUBLISHED',
  prices: { some: {} },
} satisfies Prisma.PlanVersionWhereInput;

/** `tags` is a JSON column; anything else is treated as "no tags". */
const toStringArray = (value: Prisma.JsonValue | null): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const toCatalogPlan = (plan: PlanRow): CatalogPlan | null => {
  const version = plan.versions[0];
  if (!version) {
    return null;
  }

  return {
    code: plan.code,
    displayName: plan.displayName,
    description: plan.description,
    planVersionId: version.id,
    version: version.version,
    maxActivations: version.maxActivations,
    trial:
      version.trialDays > 0
        ? {
            days: version.trialDays,
            maxActivations: version.trialMaxActivations,
          }
        : null,
    prices: version.prices.map((price) => ({
      interval: price.interval,
      priceCents: price.priceCents,
      currency: price.currency,
    })),
    features: [...version.features]
      .sort((left, right) =>
        left.feature.code.localeCompare(right.feature.code),
      )
      .map((link) => ({ code: link.feature.code, value: link.value })),
  };
};

const toCatalogProduct = (product: ProductRow): CatalogProduct => ({
  code: product.code,
  displayName: product.displayName,
  description: product.description,
  vendor: product.vendor,
  websiteUrl: product.websiteUrl,
  iconUrl: product.iconUrl,
  tags: toStringArray(product.tags),
  sortOrder: product.sortOrder,
  plans: product.plans
    .map(toCatalogPlan)
    .filter((plan): plan is CatalogPlan => plan !== null),
});

/**
 * Read model of the catalogue.
 *
 * Availability is decided here once: a product is listed only when it is
 * active and still offers a plan with a PUBLISHED version that has at least one
 * price. An edition without a sellable version cannot be bought, so it is not
 * shown.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listCatalog(): Promise<CatalogResponse> {
    const products = await this.prisma.product.findMany({
      where: {
        active: true,
        plans: { some: { versions: { some: SELLABLE_VERSION } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        plans: {
          where: { versions: { some: SELLABLE_VERSION } },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          include: {
            versions: {
              where: { status: 'PUBLISHED' },
              include: VERSION_INCLUDE,
            },
          },
        },
      },
    });

    return { products: products.map(toCatalogProduct) };
  }
}
