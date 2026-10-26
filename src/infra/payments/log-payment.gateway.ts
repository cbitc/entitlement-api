import { PaymentGateway } from './payment-gateway';
import type {
  PaymentInstruction,
  PaymentNotificationPayload,
  PaymentRequest,
  RefundRequest,
  RefundResult,
} from './payment-gateway';
import { yuanToCents } from './amount';

/**
 * Development/test provider: fabricates a checkout URL and trusts callbacks.
 *
 * It still speaks the same normalised payload shape as the real gateway, so the
 * order flow and its tests exercise the production code path rather than a
 * special case. Never selected in production — env validation enforces that.
 */
export class LogPaymentGateway extends PaymentGateway {
  readonly provider = 'MANUAL' as const;

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    return {
      payUrl: `http://localhost:3000/payments/manual/checkout/${request.orderNumber}`,
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
    return { providerRefundNo: `MANUAL-${request.refundNumber}` };
  }
}
