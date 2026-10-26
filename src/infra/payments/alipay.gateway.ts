import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'node:crypto';
import { AppConfig } from '../../config/app-config.service';
import { centsToYuan, yuanToCents } from './amount';
import { PaymentGateway } from './payment-gateway';
import type {
  PaymentInstruction,
  PaymentNotificationPayload,
  PaymentRequest,
  ProviderPaymentStatus,
  RefundRequest,
  RefundResult,
} from './payment-gateway';

const SIGN_TYPE = 'RSA2';

/** Keys are configurable as bare base64 or as a full PEM block. */
const toPem = (key: string, label: string): string => {
  if (key.includes('-----BEGIN')) {
    return key;
  }
  const body = key.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
};

/**
 * Alipay tools export both PKCS#8 (`BEGIN PRIVATE KEY`) and PKCS#1
 * (`BEGIN RSA PRIVATE KEY`), depending on the console page. Try both instead of
 * making the operator guess which header their base64 needs.
 */
const asPrivateKey = (raw: string): KeyObject => {
  if (raw.includes('-----BEGIN')) {
    return createPrivateKey(raw);
  }
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY']) {
    try {
      return createPrivateKey(toPem(raw, label));
    } catch {
      // Try the other encoding.
    }
  }
  throw new Error(
    'ALIPAY_PRIVATE_KEY is neither a PKCS#8 nor a PKCS#1 private key',
  );
};

/** Same story for the public key: SPKI or PKCS#1. */
const asPublicKey = (raw: string): KeyObject => {
  if (raw.includes('-----BEGIN')) {
    return createPublicKey(raw);
  }
  for (const label of ['PUBLIC KEY', 'RSA PUBLIC KEY']) {
    try {
      return createPublicKey(toPem(raw, label));
    } catch {
      // Try the other encoding.
    }
  }
  throw new Error(
    'ALIPAY_PUBLIC_KEY is neither an SPKI nor a PKCS#1 public key',
  );
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

/** `yyyy-MM-dd HH:mm:ss` in Asia/Shanghai, as Alipay sends it. */
const parseAlipayTime = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const parsed = new Date(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Alipay signs the exact bytes it sends, and the gateway may answer in GBK
 * regardless of the request charset. Decode only for JSON parsing; slice the
 * signed node out of the raw buffer so the bytes stay untouched.
 */
const readAlipayResponse = async (
  response: Response,
  nodeKey: string,
): Promise<{ body: Record<string, unknown>; node: Buffer | null }> => {
  const buffer = Buffer.from(await response.arrayBuffer());

  const contentType = response.headers.get('content-type') ?? '';
  const charset =
    /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase() ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(charset === 'gbk' ? 'gbk' : charset).decode(buffer);
  } catch {
    text = buffer.toString('utf8');
  }

  const parsed = JSON.parse(text) as Record<string, unknown>;
  return { body: parsed, node: extractNodeBytes(buffer, nodeKey) };
};

/**
 * The node is delimited by ASCII markers, which cannot appear inside a GBK
 * multi-byte sequence, so byte-level slicing is safe for every charset.
 */
const extractNodeBytes = (buffer: Buffer, key: string): Buffer | null => {
  const marker = Buffer.from(`"${key}":`);
  let start = buffer.indexOf(marker);
  if (start < 0) {
    return null;
  }
  start += marker.length;
  while (start < buffer.length && buffer[start] !== 0x7b) {
    start += 1;
  }
  if (start >= buffer.length) {
    return null;
  }

  const end = buffer.lastIndexOf(Buffer.from(',"sign":"'));
  if (end <= start) {
    return null;
  }

  return buffer.subarray(start, end);
};

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
      asPublicKey(this.config.alipay.publicKey),
      signature,
      'base64',
    );
  }

  parseNotification(
    payload: Readonly<Record<string, string>>,
  ): PaymentNotificationPayload {
    const orderNumber = payload.out_trade_no ?? '';
    const total = payload.total_amount ?? '';
    const paidAt = parseAlipayTime(payload.gmt_payment);

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

  async queryPayment(orderNumber: string): Promise<ProviderPaymentStatus> {
    const alipay = this.config.alipay;
    const params: Record<string, string> = {
      app_id: alipay.appId,
      method: 'alipay.trade.query',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: SIGN_TYPE,
      timestamp: timestamp(new Date()),
      version: '1.0',
      biz_content: JSON.stringify({ out_trade_no: orderNumber }),
    };
    params.sign = this.sign(params);

    const response = await fetch(alipay.gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    let parsed: { body: Record<string, unknown>; node: Buffer | null };
    try {
      parsed = await readAlipayResponse(
        response,
        'alipay_trade_query_response',
      );
    } catch {
      throw new Error('Alipay returned a non-JSON response');
    }
    const { body, node } = parsed;
    const queryResponse = body.alipay_trade_query_response as
      Record<string, unknown> | undefined;
    if (!queryResponse) {
      throw new Error('Alipay returned an unexpected response');
    }
    const signature = body.sign;
    if (
      typeof signature === 'string' &&
      (!node || !this.verifySignature(node, signature))
    ) {
      throw new Error('Alipay response signature is invalid');
    }

    const code = String(queryResponse.code ?? '');
    const subCode = String(queryResponse.sub_code ?? '');
    if (code !== '10000') {
      if (subCode === 'ACQ.TRADE_NOT_EXIST') {
        return { state: 'NOT_FOUND', providerStatus: subCode };
      }
      throw new Error(
        `Alipay query failed: ${code} ${subCode} ${String(
          queryResponse.sub_msg ?? queryResponse.msg ?? '',
        )}`.trim(),
      );
    }

    const providerStatus = String(queryResponse.trade_status ?? '');
    const result: ProviderPaymentStatus = {
      state: 'PENDING',
      providerStatus,
      providerTradeNo: queryResponse.trade_no
        ? String(queryResponse.trade_no)
        : undefined,
      amountCents: queryResponse.total_amount
        ? yuanToCents(String(queryResponse.total_amount))
        : undefined,
      currency: 'cny',
      paidAt: parseAlipayTime(queryResponse.send_pay_date),
      buyerId: queryResponse.buyer_user_id
        ? String(queryResponse.buyer_user_id)
        : undefined,
    };

    if (
      providerStatus === 'TRADE_SUCCESS' ||
      providerStatus === 'TRADE_FINISHED'
    ) {
      return { ...result, state: 'CAPTURED' };
    }
    if (providerStatus === 'TRADE_CLOSED') {
      return { ...result, state: 'CLOSED' };
    }
    return result;
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
    const { body, node } = await readAlipayResponse(
      response,
      'alipay_trade_refund_response',
    );
    const result = body.alipay_trade_refund_response as
      { code?: string; msg?: string } | undefined;
    if (!response.ok || result?.code !== '10000') {
      throw new Error(
        `Alipay refund rejected: ${result?.code ?? response.status} ${result?.msg ?? ''}`.trim(),
      );
    }
    const signature = body.sign;
    if (
      typeof signature === 'string' &&
      (!node || !this.verifySignature(node, signature))
    ) {
      throw new Error('Alipay refund response signature is invalid');
    }

    // Alipay identifies a refund by the merchant's `out_request_no`.
    return { providerRefundNo: request.refundNumber };
  }

  private sign(params: Readonly<Record<string, string>>): string {
    const signer = createSign('RSA-SHA256');
    signer.update(signable(params, ['sign']), 'utf8');
    signer.end();
    return signer.sign(asPrivateKey(this.config.alipay.privateKey), 'base64');
  }

  private verifySignature(node: Buffer, signature: string): boolean {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(node);
    verifier.end();
    return verifier.verify(
      asPublicKey(this.config.alipay.publicKey),
      signature,
      'base64',
    );
  }
}
