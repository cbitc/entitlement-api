/**
 * Drives a sandbox purchase against a locally running API.
 *
 * Usage:
 *   node scripts/sandbox-flow.mjs create [email]
 *   node scripts/sandbox-flow.mjs sync <orderId> [email]
 *   node scripts/sandbox-flow.mjs show <orderId> [email]
 *   node scripts/sandbox-flow.mjs subscription <subscriptionId> [email]
 *   node scripts/sandbox-flow.mjs refund <orderId> [adminEmail]
 *
 * The script signs a session token directly for a development account so the
 * flow does not depend on reading login codes out of the log stream. It only
 * prints order data and the one-time payment URL.
 */
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

config();

const prisma = new PrismaClient();
const base = `http://localhost:${process.env.PORT ?? 3000}`;
const jwt = new JwtService({
  secret: process.env.JWT_SECRET,
  signOptions: {
    expiresIn: Number(process.env.JWT_TTL_SECONDS ?? 3600),
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },
});

const [command, first, second] = process.argv.slice(2);

if (!command) {
  console.error(
    'usage: create [email] | sync <orderId> [email] | show <orderId> [email] | subscription <id> [email] | refund <orderId> [adminEmail]',
  );
  process.exit(1);
}

const isAdmin = command === 'refund';
const email =
  (command === 'create' ? first : second) ??
  (isAdmin ? 'sandbox-admin@example.com' : 'sandbox@example.com');

const user = await prisma.user.upsert({
  where: { email },
  update: isAdmin ? { role: 'ADMIN' } : {},
  create: {
    email,
    displayName: isAdmin ? 'Sandbox Admin' : 'Sandbox Buyer',
    role: isAdmin ? 'ADMIN' : 'CUSTOMER',
    emailVerifiedAt: new Date(),
  },
});

const token = await jwt.signAsync(
  { email: user.email, role: user.role },
  { subject: user.id },
);

const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    console.error(`${method} ${path} -> ${response.status}`);
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return parsed;
};

const describeOrder = (order) => ({
  orderId: order.id,
  number: order.number,
  status: order.status,
  amountCents: order.amountCents,
  currency: order.currency,
  subscriptionId: order.subscriptionId,
  paidAt: order.paidAt,
  failureReason: order.failureReason,
});

try {
  if (command === 'create') {
    const order = await api('POST', '/orders', {
      productCode: process.env.SANDBOX_PRODUCT ?? 'intellij-idea',
      planCode: process.env.SANDBOX_PLAN ?? 'standard',
      interval: process.env.SANDBOX_INTERVAL ?? 'MONTH',
    });
    const checkout = await api('POST', `/orders/${order.id}/payments`, {});
    console.log(
      JSON.stringify(
        { ...describeOrder(order), payUrl: checkout.payUrl },
        null,
        2,
      ),
    );
  } else if (command === 'sync') {
    if (!first) {
      throw new Error('sync needs an order id');
    }
    const order = await api('POST', `/orders/${first}/sync`);
    console.log(JSON.stringify(describeOrder(order), null, 2));
  } else if (command === 'show') {
    if (!first) {
      throw new Error('show needs an order id');
    }
    const order = await api('GET', `/orders/${first}`);
    console.log(JSON.stringify(describeOrder(order), null, 2));
  } else if (command === 'subscription') {
    if (!first) {
      throw new Error('subscription needs an id');
    }
    const subscription = await api('GET', `/subscriptions/${first}`);
    console.log(
      JSON.stringify(
        {
          id: subscription.id,
          productCode: subscription.productCode,
          status: subscription.status,
          currentPeriod: subscription.currentPeriod,
          renewal: subscription.renewal,
          pendingChange: subscription.pendingChange,
          features: subscription.features,
        },
        null,
        2,
      ),
    );
  } else if (command === 'refund') {
    if (!first) {
      throw new Error('refund needs an order id');
    }
    const order = await api('POST', `/orders/${first}/refunds`, {
      reason: process.env.SANDBOX_REFUND_REASON ?? 'Sandbox integration test',
    });
    console.log(
      JSON.stringify(
        {
          ...describeOrder(order),
          refundedCents: order.refundedCents,
          refunds: order.refunds,
        },
        null,
        2,
      ),
    );
  } else {
    throw new Error(`unknown command "${command}"`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
