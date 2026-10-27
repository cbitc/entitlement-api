import { PaymentGateway } from './payment-gateway';
import type {
  PaymentInstruction,
  PaymentNotificationPayload,
  PaymentRequest,
  ProviderPaymentStatus,
  RefundRequest,
  RefundResult,
} from './payment-gateway';
import { yuanToCents } from './amount';

/**
 * Development/test stand-in for Alipay: fabricates a checkout URL and trusts
 * callbacks.
 *
 * It reports the same provider as the real gateway so the order flow and tests
 * never need a second payment channel. Never selected in production — env
 * validation enforces the real Alipay gateway there.
 */
export class LogPaymentGateway extends PaymentGateway {
  readonly provider = 'ALIPAY' as const;

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    return {
      payUrl: `http://localhost:3000/payments/alipay/checkout/${request.orderNumber}`,
      providerTradeNo: `LOG-${request.orderNumber}`,
    };
  }

  verifyNotification(): boolean {
    return true;
  }

  parseNotification(
    payload: Readonly<Record<string, string>>,
  ): PaymentNotificationPayload {
    const orderNumber = payload.out_trade_no ?? payload.orderNumber ?? '';
    const eventType =
      payload.trade_status ?? payload.eventType ?? 'TRADE_SUCCESS';
    const amountCents = payload.amountCents
      ? Number(payload.amountCents)
      : yuanToCents(payload.total_amount ?? '0');

    return {
      externalId:
        payload.notify_id ?? payload.notifyId ?? `${orderNumber}:${eventType}`,
      eventType,
      orderNumber,
      providerTradeNo: payload.trade_no ?? payload.providerTradeNo,
      amountCents,
      currency: payload.currency ?? 'cny',
      paidAt: payload.gmt_payment ? new Date(payload.gmt_payment) : new Date(),
      buyerId: payload.buyer_id,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    return { providerRefundNo: `LOG-${request.refundNumber}` };
  }

  /** The fake provider has no remote state to query. */
  async queryPayment(): Promise<ProviderPaymentStatus> {
    return { state: 'NOT_FOUND', providerStatus: 'LOG_GATEWAY' };
  }
}
