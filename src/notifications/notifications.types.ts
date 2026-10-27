import type {
  NotificationType,
  OutboundNotificationStatus,
} from '@prisma/client';

/** Snapshot of a captured payment, rendered into a receipt. */
export interface PaymentSucceededPayload {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly productName: string;
  readonly planName: string;
  readonly interval: 'MONTH' | 'YEAR';
  readonly amountCents: number;
  readonly currency: string;
  readonly paidAt: string;
  /** When the purchased term starts; absent for an immediate new purchase. */
  readonly startsAt: string | null;
  /** End of the granted term, when it is already known. */
  readonly endsAt: string | null;
}

/** A subscription that reached its boundary without a paid renewal. */
export interface SubscriptionExpiredPayload {
  readonly subscriptionId: string;
  readonly productName: string;
  readonly planName: string;
  readonly endedAt: string;
  /** The account was paused, so the term ran out instead of renewing. */
  readonly paused: boolean;
}

/** Money returned to the customer. */
export interface RefundIssuedPayload {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reason: string;
  readonly completedAt: string;
}

export interface NotificationPayloadByType {
  readonly PAYMENT_SUCCEEDED: PaymentSucceededPayload;
  readonly SUBSCRIPTION_EXPIRED: SubscriptionExpiredPayload;
  readonly REFUND_ISSUED: RefundIssuedPayload;
}

/** Everything a template needs besides the payload. */
export interface TemplateContext {
  readonly appName: string;
  readonly webUrl: string;
  readonly timeZone: string;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface AdminNotificationView {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string;
  readonly type: NotificationType;
  readonly status: OutboundNotificationStatus;
  readonly subject: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly sentAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface AdminNotificationFilter {
  readonly status?: OutboundNotificationStatus;
  readonly type?: NotificationType;
  readonly email?: string;
  readonly userId?: string;
}

export interface DispatchResult {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
}
