import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import type {
  CatalogPlan,
  CatalogProduct,
  CatalogResponse,
} from './catalog.types';

type PlanRow = Prisma.PlanGetPayload<{
  include: { prices: true; features: { include: { feature: true } } };
}>;

type ProductRow = Prisma.ProductGetPayload<{
  include: {
    plans: {
      include: { prices: true; features: { include: { feature: true } } };
    };
  };
}>;

/** `tags` is a JSON column; anything else is treated as "no tags". */
const toStringArray = (value: Prisma.JsonValue | null): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const toCatalogPlan = (plan: PlanRow): CatalogPlan => ({
  code: plan.code,
  displayName: plan.displayName,
  description: plan.description,
  maxActivations: plan.maxActivations,
  trial:
    plan.trialDays > 0
      ? { days: plan.trialDays, maxActivations: plan.trialMaxActivations }
      : null,
  prices: plan.prices.map((price) => ({
    interval: price.interval,
    priceCents: price.priceCents,
    currency: price.currency,
  })),
  features: [...plan.features]
    .sort((left, right) => left.feature.code.localeCompare(right.feature.code))
    .map((link) => ({ code: link.feature.code, value: link.value })),
});

const toCatalogProduct = (product: ProductRow): CatalogProduct => ({
  code: product.code,
  displayName: product.displayName,
  description: product.description,
  vendor: product.vendor,
  websiteUrl: product.websiteUrl,
  iconUrl: product.iconUrl,
  tags: toStringArray(product.tags),
  sortOrder: product.sortOrder,
  plans: product.plans.map(toCatalogPlan),
});

/**
 * Read model of the catalogue.
 *
 * Availability is decided here once: a product is listed only when it is
 * active and still offers an active plan that has at least one price. An
 * edition without a term cannot be bought, so it is not shown.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listCatalog(): Promise<CatalogResponse> {
    const products = await this.prisma.product.findMany({
      where: {
        active: true,
        plans: { some: { active: true, prices: { some: {} } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        plans: {
          where: { active: true, prices: { some: {} } },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          include: {
            prices: { orderBy: [{ interval: 'asc' }, { currency: 'asc' }] },
            features: { include: { feature: true } },
          },
        },
      },
    });

    return { products: products.map(toCatalogProduct) };
  }
}
