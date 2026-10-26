/**
 * Alipay sandbox connectivity check.
 *
 * Proves three things without touching the database or moving money:
 *   1. the app private key is readable and can sign;
 *   2. the gateway URL answers;
 *   3. the configured public key really is Alipay's (the response signature
 *      verifies), which is the mistake people most often make — pasting the
 *      application public key instead of the Alipay public key.
 *
 * Run after `pnpm build` so the compiled gateway is available.
 */
import { config } from 'dotenv';
import { createRequire } from 'node:module';

config();

const require = createRequire(import.meta.url);
const { AlipayGateway } = require('../dist/infra/payments/alipay.gateway.js');

const alipay = {
  appId: process.env.ALIPAY_APP_ID ?? '',
  privateKey: process.env.ALIPAY_PRIVATE_KEY ?? '',
  publicKey: process.env.ALIPAY_PUBLIC_KEY ?? '',
  gatewayUrl: process.env.ALIPAY_GATEWAY_URL ?? '',
  notifyUrl: process.env.PAYMENT_NOTIFY_URL ?? '',
  returnUrl: process.env.PAYMENT_RETURN_URL ?? '',
};

const missing = Object.entries(alipay)
  .filter(([, value]) => value.length === 0)
  .map(([key]) => key);
if (missing.length > 0) {
  console.error(`Missing configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const gateway = new AlipayGateway({ alipay });
const orderNumber = `SANDBOXCHECK${Date.now()}`;

try {
  const status = await gateway.queryPayment(orderNumber);
  console.log(
    `query ok: state=${status.state} providerStatus=${status.providerStatus ?? '-'}`,
  );
} catch (error) {
  console.error(`query failed: ${error.message}`);
  console.error(
    'Hints: "signature is invalid" usually means ALIPAY_PUBLIC_KEY is the app public key, not the Alipay public key.',
  );
  process.exit(1);
}

try {
  const instruction = await gateway.createPayment({
    orderNumber,
    subject: 'Sandbox connectivity check',
    amountCents: 1,
    currency: 'cny',
    notifyUrl: alipay.notifyUrl,
    returnUrl: alipay.returnUrl,
  });
  const url = new URL(instruction.payUrl);
  console.log(
    `page pay signed: host=${url.host} params=${[...url.searchParams.keys()].length}`,
  );
} catch (error) {
  console.error(`page pay signing failed: ${error.message}`);
  process.exit(1);
}

console.log('sandbox configuration looks usable');
