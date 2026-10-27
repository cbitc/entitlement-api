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

export interface CatalogPlan {
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  /** The version these terms belong to; what a purchase would pin. */
  readonly planVersionId: string;
  readonly version: number;
  /** Devices one paid seat may activate. */
  readonly maxActivations: number;
  readonly trial: CatalogTrial | null;
  readonly prices: readonly CatalogPrice[];
  /** Boolean feature codes this version includes, sorted by code. */
  readonly features: readonly string[];
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
