import type {
  PlanInterval,
  PlanVersionStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';

/** The account as the support console sees it. */
export interface AdminUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

export interface AdminUserDetailView extends AdminUserView {
  readonly subscriptionCount: number;
  readonly orderCount: number;
}

/** One sellable version, including drafts that are not in the shop yet. */
export interface AdminVersionView {
  readonly id: string;
  readonly version: number;
  readonly status: PlanVersionStatus;
  readonly maxActivations: number;
  readonly trialDays: number;
  readonly trialMaxActivations: number;
  readonly publishedAt: string | null;
  readonly saleClosedAt: string | null;
  readonly retiredAt: string | null;
  readonly prices: readonly AdminPriceView[];
  readonly features: readonly string[];
  readonly createdAt: string;
}

export interface AdminPriceView {
  readonly interval: PlanInterval;
  readonly currency: string;
  readonly priceCents: number;
}

export interface AdminPlanView {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly versions: readonly AdminVersionView[];
}

export interface AdminProductView {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly vendor: string | null;
  readonly websiteUrl: string | null;
  readonly iconUrl: string | null;
  readonly tags: readonly string[];
  readonly sortOrder: number;
  readonly active: boolean;
  readonly plans: readonly AdminPlanView[];
}

export interface AdminFeatureView {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly createdAt: string;
}

/**
 * The application clock as the console sees it.
 *
 * `now` and `realNow` are returned together so the UI can show the drift, and
 * `enabled` distinguishes "the feature is off" from "time is on the wall
 * clock", which otherwise look identical.
 */
export interface ClockStateView {
  readonly enabled: boolean;
  readonly controlled: boolean;
  readonly now: string;
  readonly realNow: string;
  readonly offsetMs: number;
  readonly pinnedAt: string | null;
}
