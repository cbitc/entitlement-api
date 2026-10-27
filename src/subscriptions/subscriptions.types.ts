import type {
  PlanInterval,
  SubscriptionChangeKind,
  SubscriptionPeriodCloseReason,
  SubscriptionPeriodKind,
  SubscriptionStatus,
} from '@prisma/client';

/**
 * One frozen billing term as the API exposes it. The terms are a snapshot: they
 * do not change when the catalogue does.
 */
export interface SubscriptionPeriodView {
  readonly id: string;
  readonly sequence: number;
  readonly kind: SubscriptionPeriodKind;
  readonly planCode: string;
  readonly planVersionId: string;
  readonly version: number;
  readonly interval: PlanInterval | null;
  readonly quantity: number | null;
  readonly unitPriceCents: number | null;
  readonly currency: string | null;
  readonly maxActivations: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly endedAt: string | null;
  readonly closeReason: SubscriptionPeriodCloseReason | null;
}

/**
 * What happens next, without writing it to the row: a pending intent if one
 * exists, otherwise the current period. This is where price protection shows up.
 */
export interface SubscriptionRenewalView {
  readonly source: 'PERIOD' | 'CHANGE';
  readonly planCode: string;
  readonly version: number;
  readonly interval: PlanInterval | null;
  readonly quantity: number | null;
  readonly effectiveAt: string;
}

export interface SubscriptionChangeView {
  readonly id: string;
  readonly kind: SubscriptionChangeKind;
  readonly effectiveAt: string;
  readonly planCode: string | null;
  readonly version: number | null;
  readonly interval: PlanInterval | null;
  readonly quantity: number | null;
}

export interface SubscriptionView {
  readonly id: string;
  readonly productCode: string;
  readonly status: SubscriptionStatus;
  readonly startedAt: string;
  readonly currentPeriod: SubscriptionPeriodView | null;
  readonly renewal: SubscriptionRenewalView | null;
  readonly pendingChange: SubscriptionChangeView | null;
  /**
   * Boolean capabilities of the running period, sorted by code. Empty unless
   * the subscription is live and its period has not ended.
   */
  readonly features: readonly string[];
}

/** One running term as the admin views it: enough to reason about, no history. */
export interface AdminSubscriptionPeriodView {
  readonly id: string;
  readonly sequence: number;
  readonly kind: SubscriptionPeriodKind;
  readonly planCode: string;
  readonly planVersionId: string;
  readonly version: number;
  readonly interval: PlanInterval | null;
  readonly quantity: number | null;
  readonly unitPriceCents: number | null;
  readonly currency: string | null;
  readonly maxActivations: number;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** A subscription plus its owner, for the support console. */
export interface AdminSubscriptionView {
  readonly id: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly productCode: string;
  readonly status: SubscriptionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly currentPeriod: AdminSubscriptionPeriodView | null;
  readonly features: readonly string[];
}
