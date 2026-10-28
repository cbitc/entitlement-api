import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { PlanInterval } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/infra/clock/clock';
import { FakeClock } from './support/fake-clock';
import { SessionTokenService } from '../src/auth/session-token.service';
import { AppConfig } from '../src/config/app-config.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { JobRunnerService } from '../src/scheduling/job-runner.service';

/**
 * The outbox is written by the same transactions that capture money, so these
 * tests drive the real callback path rather than inserting rows by hand.
 * Run `pnpm db:test:deploy` first.
 */
describe('Outbound notifications (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;
  let orders: OrdersService;
  let jobs: JobRunnerService;

  let notifySeq = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const notify = (body: Record<string, string>) =>
    http().post('/payments/alipay/notify').type('form').send(body).expect(200);

  const signIn = async (
    email: string,
    role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER',
  ) => {
    const user = await prisma.user.create({
      data: { email, role, emailVerifiedAt: new Date() },
    });
    return { user, token: await tokens.issue(user) };
  };

  const seedCatalogue = async () => {
    const product = await prisma.product.create({
      data: { code: 'ai-platform', displayName: 'AI Platform' },
    });
    const plan = await prisma.plan.create({
      data: { productId: product.id, code: 'standard', displayName: '标准版' },
    });
    const version = await prisma.planVersion.create({
      data: {
        planId: plan.id,
        version: 1,
        status: 'PUBLISHED',
        publishedKey: plan.id,
        publishedAt: new Date(),
        maxActivations: 3,
        trialDays: 30,
        trialMaxActivations: 1,
        prices: {
          create: [
            {
              interval: 'MONTH' satisfies PlanInterval,
              currency: 'cny',
              priceCents: 9900,
            },
          ],
        },
      },
    });

    return { product, plan, version };
  };

  const createOrder = (token: string) =>
    http().post('/orders').set(auth(token)).send({
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    });

  const notificationFor = (order: {
    number: string;
    amountCents: number;
    currency: string;
  }) => ({
    notify_id: `N-${notifySeq++}`,
    out_trade_no: order.number,
    trade_status: 'TRADE_SUCCESS',
    trade_no: `T-${order.number}`,
    total_amount: (order.amountCents / 100).toFixed(2),
    currency: order.currency,
    gmt_payment: new Date().toISOString(),
  });

  const purchase = async (token: string) => {
    const created = await createOrder(token).expect(201);
    const checkout = await http()
      .post(`/orders/${created.body.id}/payments`)
      .set(auth(token))
      .send({})
      .expect(200);
    expect(typeof checkout.body.payUrl).toBe('string');

    const payload = notificationFor(created.body);
    await notify(payload);
    // A provider retry must not enqueue a second receipt.
    await notify(payload);

    const order = await http()
      .get(`/orders/${created.body.id}`)
      .set(auth(token))
      .expect(200);
    expect(order.body.status).toBe('FULFILLED');
    return order.body;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(Clock)
      .useValue(new FakeClock())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(SessionTokenService);
    orders = app.get(OrdersService);
    jobs = app.get(JobRunnerService);

    expect(app.get(AppConfig).schedulerEnabled).toBe(false);
  });

  beforeEach(async () => {
    notifySeq = 0;
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.refund.deleteMany();
    await prisma.paymentNotification.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.order.deleteMany();
    await prisma.deviceActivation.deleteMany();
    await prisma.subscriptionChange.deleteMany();
    await prisma.subscriptionPeriod.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.trialRedemption.deleteMany();
    await prisma.planVersionFeature.deleteMany();
    await prisma.planVersionPrice.deleteMany();
    await prisma.planVersion.deleteMany();
    await prisma.feature.deleteMany();
    await prisma.plan.deleteMany();
    await prisma.product.deleteMany();
    await prisma.verificationCode.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('enqueues one receipt per captured payment and marks it sent', async () => {
    const { product } = await seedCatalogue();
    const { user, token } = await signIn('buyer@example.com');

    await purchase(token);

    const rows = await prisma.outboundNotification.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    const row = await prisma.outboundNotification.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      status: 'PENDING',
      email: user.email,
    });
    expect(row.subject).toContain(product.displayName);

    const outcome = await jobs.run('notifications', {
      limit: 10,
      source: 'admin',
    });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.result).toMatchObject({ sent: 1, failed: 0 });

    const sent = await prisma.outboundNotification.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(sent.status).toBe('SENT');
    expect(sent.sentAt).not.toBeNull();
    expect(sent.attempts).toBe(1);
  });

  it('emails an expired subscription and lets an admin resend it', async () => {
    const { product } = await seedCatalogue();
    const { user, token } = await signIn('trial@example.com');
    const { user: admin, token: adminToken } = await signIn(
      'admin@example.com',
      'ADMIN',
    );
    expect(admin.id).toBeTruthy();

    const trial = await http()
      .post('/subscriptions')
      .set(auth(token))
      .send({
        productCode: 'ai-platform',
        planCode: 'standard',
        interval: 'MONTH',
        trial: true,
      })
      .expect(201);

    await orders.settleDueSubscriptions(
      new Date(new Date(trial.body.currentPeriod.endsAt).getTime() + 1),
      10,
    );

    const row = await prisma.outboundNotification.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row).toMatchObject({
      type: 'SUBSCRIPTION_EXPIRED',
      status: 'PENDING',
    });
    expect(row.subject).toContain(product.displayName);

    const page = await http()
      .get('/admin/notifications')
      .query({ email: 'trial@example.com' })
      .set(auth(adminToken))
      .expect(200);
    expect(page.body.total).toBe(1);
    expect(page.body.items[0].type).toBe('SUBSCRIPTION_EXPIRED');

    const resent = await http()
      .post(`/admin/notifications/${row.id}/resend`)
      .set(auth(adminToken))
      .expect(200);
    expect(resent.body.status).toBe('PENDING');
    expect(resent.body.attempts).toBe(0);
  });

  it('emails a refund and revokes the period without an expiry mail', async () => {
    await seedCatalogue();
    const { user, token } = await signIn('refund@example.com');
    const { token: adminToken } = await signIn(
      'refund-admin@example.com',
      'ADMIN',
    );

    const order = await purchase(token);

    await http()
      .post(`/orders/${order.id}/refunds`)
      .set(auth(adminToken))
      .send({ reason: 'customer request' })
      .expect(200);

    const refund = await prisma.outboundNotification.findFirstOrThrow({
      where: { userId: user.id, type: 'REFUND_ISSUED' },
    });
    expect(refund.status).toBe('PENDING');
    expect(refund.subject).toContain(order.number);

    expect(
      await prisma.outboundNotification.count({
        where: { userId: user.id, type: 'SUBSCRIPTION_EXPIRED' },
      }),
    ).toBe(0);
  });
});
