import type { SubscriptionStatus } from '@prisma/client';

/** One machine currently holding an activation slot. */
export interface LicenseActivationView {
  readonly id: string;
  readonly machineId: string;
  readonly activatedAt: string;
  readonly lastRefreshedAt: string;
}

/**
 * A license as the API exposes it. There is no license table: this is a read
 * model of the subscription's running period and the version it pinned.
 */
export interface LicenseView {
  readonly product: string;
  /** The edition (plan code), never the billing term. */
  readonly plan: string;
  readonly trial: boolean;
  readonly status: SubscriptionStatus;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly maxActivations: number;
  /** Boolean feature codes of the pinned version, sorted. */
  readonly features: readonly string[];
  readonly activations: readonly LicenseActivationView[];
}

export interface LicenseTokenView {
  readonly token: string;
  readonly plan: string;
  readonly trial: boolean;
  readonly features: readonly string[];
  readonly expiresAt: string;
}

export interface LicenseListResponse {
  readonly licenses: readonly LicenseView[];
}

/** A license plus its owner, for the support console. */
export interface AdminLicenseView extends LicenseView {
  readonly userId: string;
  readonly userEmail: string;
}

export interface AdminLicenseFilter {
  readonly email?: string;
  readonly userId?: string;
  readonly product?: string;
}
