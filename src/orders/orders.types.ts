import type {
  OrderKind,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  PlanInterval,
  RefundStatus,
} from '@prisma/client';

export interface OrderPaymentView {
  readonly id: string;
  readonly provider: PaymentProvider;
  readonly status: PaymentStatus;
  readonly amountCents: number;
  readonly currency: string;
  readonly paidAt: string | null;
}

export interface OrderRefundView {
  readonly id: string;
  readonly amountCents: number;
  readonly status: RefundStatus;
  readonly reason: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

export interface OrderView {
  readonly id: string;
  readonly number: string;
  readonly kind: OrderKind;
  readonly status: OrderStatus;
  readonly productCode: string;
  readonly planCode: string;
  readonly planVersionId: string;
  readonly version: number;
  readonly interval: PlanInterval;
  readonly unitPriceCents: number;
  readonly amountCents: number;
  readonly currency: string;
  readonly subscriptionId: string | null;
  /** For a renewal: the boundary at which it takes effect. */
  readonly appliesAt: string | null;
  readonly expiresAt: string;
  readonly paidAt: string | null;
  readonly fulfilledAt: string | null;
  readonly closedAt: string | null;
  readonly failureReason: string | null;
  readonly refundedCents: number;
  readonly payments: readonly OrderPaymentView[];
  readonly refunds: readonly OrderRefundView[];
}

export interface CheckoutView {
  readonly order: OrderView;
  readonly payment: {
    readonly id: string;
    readonly provider: PaymentProvider;
    readonly status: PaymentStatus;
  };
  readonly payUrl: string;
}
