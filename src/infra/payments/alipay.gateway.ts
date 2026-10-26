import { createHash, createSign, createVerify } from 'node:crypto';
import { AppConfig } from '../../config/app-config.service';
import { centsToYuan, yuanToCents } from './amount';
import { PaymentGateway } from './payment-gateway';
import type {
  PaymentInstruction,
  PaymentNotificationPayload,
  PaymentRequest,
  RefundRequest,
  RefundResult,
} from './payment-gateway';

const SIGN_TYPE = 'RSA2';

/** Keys are configurable as bare base64 or as a full PEM block. */
const toPem = (key: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string => {
  if (key.includes('-----BEGIN')) {
    return key;
  }
  const body = key.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
};

/** Alipay expects `yyyy-MM-dd HH:mm:ss` in Asia/Shanghai. */
const timestamp = (now: Date): string =>
  new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

/**
 * Alipay's canonical string: all non-empty parameters, sorted by key, joined
 * with `&`. Requests exclude only `sign`; notifications exclude `sign_type`
 * too, as the provider does when it verifies its own callback.
 */
const signable = (
  params: Readonly<Record<string, string | undefined>>,
  excluded: readonly string[],
): string =>
  Object.keys(params)
    .filter(
      (key) =>
        !excluded.includes(key) &&
        params[key] !== undefined &&
        params[key] !== '',
    )
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

export class AlipayGateway extends PaymentGateway {
  readonly provider = 'ALIPAY' as const;

  constructor(private readonly config: AppConfig) {
    super();
  }

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    const alipay = this.config.alipay;
    const params: Record<string, string> = {
      app_id: alipay.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: SIGN_TYPE,
      timestamp: timestamp(new Date()),
      version: '1.0',
      notify_url: request.notifyUrl,
      return_url: request.returnUrl,
      biz_content: JSON.stringify({
        out_trade_no: request.orderNumber,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: centsToYuan(request.amountCents),
        subject: request.subject,
      }),
    };
    params.sign = this.sign(params);

    return {
      payUrl: `${alipay.gatewayUrl}?${new URLSearchParams(params).toString()}`,
    };
  }

  verifyNotification(payload: Readonly<Record<string, string>>): boolean {
    const signature = payload.sign;
    if (!signature || (payload.sign_type ?? SIGN_TYPE) !== SIGN_TYPE) {
      return false;
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signable(payload, ['sign', 'sign_type']), 'utf8');
    verifier.end();
    return verifier.verify(
      toPem(this.config.alipay.publicKey, 'PUBLIC KEY'),
      signature,
      'base64',
    );
  }

  parseNotification(
    payload: Readonly<Record<string, string>>,
  ): PaymentNotificationPayload {
    const orderNumber = payload.out_trade_no ?? '';
    const total = payload.total_amount ?? '';
    const paidAt = payload.gmt_payment
      ? new Date(`${payload.gmt_payment.replace(' ', 'T')}+08:00`)
      : undefined;

    return {
      // `notify_id` is stable per notification; the digest keeps replays
      // idempotent even for providers that omit it.
      externalId:
        payload.notify_id ??
        createHash('sha256')
          .update(signable(payload, ['sign', 'sign_type']))
          .digest('hex'),
      eventType: payload.trade_status ?? 'UNKNOWN',
      orderNumber,
      providerTradeNo: payload.trade_no,
      amountCents: total ? yuanToCents(total) : 0,
      currency: 'cny',
      paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : undefined,
      buyerId: payload.buyer_id,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const alipay = this.config.alipay;
    const params: Record<string, string> = {
      app_id: alipay.appId,
      method: 'alipay.trade.refund',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: SIGN_TYPE,
      timestamp: timestamp(new Date()),
      version: '1.0',
      biz_content: JSON.stringify({
        out_trade_no: request.orderNumber,
        ...(request.providerTradeNo
          ? { trade_no: request.providerTradeNo }
          : {}),
        refund_amount: centsToYuan(request.amountCents),
        out_request_no: request.refundNumber,
        refund_reason: request.reason,
      }),
    };
    params.sign = this.sign(params);

    // Signature of the response is not re-verified: HTTPS plus the
    // `code === 10000` check is the documented minimum. Do not treat a network
    // failure as a successful refund under any circumstances.
    const response = await fetch(alipay.gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await response.json()) as {
      alipay_trade_refund_response?: { code?: string; msg?: string };
    };
    const result = body.alipay_trade_refund_response;
    if (!response.ok || result?.code !== '10000') {
      throw new Error(
        `Alipay refund rejected: ${result?.code ?? response.status} ${result?.msg ?? ''}`.trim(),
      );
    }

    // Alipay identifies a refund by the merchant's `out_request_no`.
    return { providerRefundNo: request.refundNumber };
  }

  private sign(params: Readonly<Record<string, string>>): string {
    const signer = createSign('RSA-SHA256');
    signer.update(signable(params, ['sign']), 'utf8');
    signer.end();
    return signer.sign(
      toPem(this.config.alipay.privateKey, 'PRIVATE KEY'),
      'base64',
    );
  }
}
