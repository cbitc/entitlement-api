import type { SubscriptionStatus } from '@prisma/client';

/** One machine currently holding an activation slot. */
export interface LicenseActivationView {
  readonly machineId: string;
  readonly activatedAt: string;
  readonly lastRefreshedAt: string;
}

/**
 * A license as the API exposes it. There is no license table: this is a read
 * model of the subscription's running period and its grant.
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
  readonly activations: readonly LicenseActivationView[];
}

export interface LicenseTokenView {
  readonly token: string;
  readonly plan: string;
  readonly trial: boolean;
  readonly expiresAt: string;
}

export interface LicenseListResponse {
  readonly licenses: readonly LicenseView[];
}

export interface AdminLicenseListResponse {
  readonly email: string;
  readonly licenses: readonly LicenseView[];
}
