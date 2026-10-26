import type { PlanInterval } from '@prisma/client';

/** One term of a plan, as sold. */
export interface CatalogPrice {
  readonly interval: PlanInterval;
  readonly priceCents: number;
  readonly currency: string;
}

/** Trial policy of an edition; absent when the edition offers no trial. */
export interface CatalogTrial {
  readonly days: number;
  readonly maxActivations: number;
}

/** A capability the plan grants. `value` follows the feature's value type. */
export interface CatalogFeature {
  readonly code: string;
  readonly value: unknown;
}

export interface CatalogPlan {
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  /** Devices one paid seat may activate. */
  readonly maxActivations: number;
  readonly trial: CatalogTrial | null;
  readonly prices: readonly CatalogPrice[];
  readonly features: readonly CatalogFeature[];
}

export interface CatalogProduct {
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly vendor: string | null;
  readonly websiteUrl: string | null;
  readonly iconUrl: string | null;
  readonly tags: readonly string[];
  readonly sortOrder: number;
  readonly plans: readonly CatalogPlan[];
}

export interface CatalogResponse {
  readonly products: readonly CatalogProduct[];
}
