import type { PaymentProvider } from '@prisma/client';

/** Everything a provider needs to start a checkout. */
export interface PaymentRequest {
  readonly orderNumber: string;
  readonly subject: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly clientIp?: string;
}

export interface PaymentInstruction {
  /** URL the browser is sent to (page pay, cashier, QR payload, ...). */
  readonly payUrl: string;
  readonly providerTradeNo?: string;
}

/**
 * A provider callback normalised into the fields the domain cares about.
 * `externalId` must be stable across retries of the same event.
 */
export interface PaymentNotificationPayload {
  readonly externalId: string;
  readonly eventType: string;
  readonly orderNumber: string;
  readonly providerTradeNo?: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly paidAt?: Date;
  readonly buyerId?: string;
}

export interface RefundRequest {
  /** Idempotency key sent to the provider as `out_request_no`. */
  readonly refundNumber: string;
  readonly orderNumber: string;
  readonly providerTradeNo?: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reason: string;
}

export interface RefundResult {
  readonly providerRefundNo: string;
}

export type ProviderPaymentState =
  'CAPTURED' | 'PENDING' | 'CLOSED' | 'NOT_FOUND';

/** What the provider currently knows about a merchant order number. */
export interface ProviderPaymentStatus {
  readonly state: ProviderPaymentState;
  /** Raw provider status, e.g. `TRADE_SUCCESS`, for logs and support. */
  readonly providerStatus?: string;
  readonly providerTradeNo?: string;
  readonly amountCents?: number;
  readonly currency?: string;
  readonly paidAt?: Date;
  readonly buyerId?: string;
}

/**
 * Outbound payment port.
 *
 * The orders module depends on this abstraction only, so the fake provider used
 * in development and tests is selected by configuration instead of branching
 * inside the domain logic.
 */
export abstract class PaymentGateway {
  abstract readonly provider: PaymentProvider;

  abstract createPayment(request: PaymentRequest): Promise<PaymentInstruction>;

  /** Rejects forged callbacks; a false result must never move money. */
  abstract verifyNotification(
    payload: Readonly<Record<string, string>>,
  ): boolean;

  /** Assumes the signature was already verified. */
  abstract parseNotification(
    payload: Readonly<Record<string, string>>,
  ): PaymentNotificationPayload;

  /**
   * Active reconciliation: asks the provider about an order.
   *
   * Callbacks can be lost or unreachable (a local sandbox cannot be called
   * back), so the money truth must be obtainable on demand, not only pushed.
   */
  abstract queryPayment(orderNumber: string): Promise<ProviderPaymentStatus>;

  abstract refund(request: RefundRequest): Promise<RefundResult>;
}
