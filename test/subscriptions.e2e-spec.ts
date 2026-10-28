import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { PlanInterval } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/infra/clock/clock';
import { FakeClock } from './support/fake-clock';
import { SessionTokenService } from '../src/auth/session-token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';

/**
 * Paid flows go through an order and a provider callback; only trials are
 * created directly. Real MySQL is required for the unique keys and row locks.
 * Run `pnpm db:test:deploy` first.
 */
describe('Subscriptions and payments (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;
  let orders: OrdersService;

  /** Drives every service that does not take an explicit `now`. */
  const clock = new FakeClock();

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

  const createProduct = () =>
    prisma.product.create({
      data: { code: 'ai-platform', displayName: 'AI Platform' },
    });

  const createPlan = (productId: string, code: string) =>
    prisma.plan.create({ data: { productId, code, displayName: code } });

  const createFeature = (code: string) =>
    prisma.feature.create({ data: { code, displayName: code } });

  const publish = async (
    planId: string,
    version: number,
    options: {
      priceCents?: number;
      trialDays?: number;
      maxActivations?: number;
      features?: ReadonlyArray<{ featureId: string }>;
    } = {},
  ) => {
    await prisma.planVersion.updateMany({
      where: { planId, status: 'PUBLISHED' },
      data: { status: 'CLOSED_FOR_SALE', publishedKey: null },
    });

    return prisma.planVersion.create({
      data: {
        planId,
        version,
        status: 'PUBLISHED',
        publishedKey: planId,
        publishedAt: new Date(),
        maxActivations: options.maxActivations ?? 3,
        trialDays: options.trialDays ?? 0,
        trialMaxActivations: 1,
        prices: {
          create: [
            {
              interval: 'MONTH' satisfies PlanInterval,
              currency: 'cny',
              priceCents: options.priceCents ?? 9900,
            },
          ],
        },
        features: {
          create: (options.features ?? []).map((feature) => ({
            featureId: feature.featureId,
          })),
        },
      },
    });
  };

  const seedCatalogue = async () => {
    const product = await createProduct();
    const standard = await createPlan(product.id, 'standard');
    const pro = await createPlan(product.id, 'pro');
    const assistant = await createFeature('ai-assistant');
    const credits = await createFeature('ai-credits');

    const standardV1 = await publish(standard.id, 1, {
      priceCents: 9900,
      trialDays: 30,
      maxActivations: 2,
      features: [{ featureId: credits.id }],
    });
    const proV1 = await publish(pro.id, 1, {
      priceCents: 29900,
      maxActivations: 5,
      features: [{ featureId: assistant.id }, { featureId: credits.id }],
    });

    return { product, standard, pro, standardV1, proV1, assistant, credits };
  };

  const createOrder = (token: string, body: Record<string, unknown>) =>
    http()
      .post('/orders')
      .set(auth(token))
      .send({
        productCode: 'ai-platform',
        planCode: 'standard',
        interval: 'MONTH',
        ...body,
      });

  const getOrder = (token: string, id: string) =>
    http().get(`/orders/${id}`).set(auth(token));

  const notificationFor = (
    order: { number: string; amountCents: number; currency: string },
    amountCents = order.amountCents,
  ) => ({
    notify_id: `N-${notifySeq++}`,
    out_trade_no: order.number,
    trade_status: 'TRADE_SUCCESS',
    trade_no: `T-${order.number}`,
    total_amount: (amountCents / 100).toFixed(2),
    currency: order.currency,
    gmt_payment: new Date().toISOString(),
  });

  /** Starts a checkout, pays it through the fake provider and re-reads it. */
  const pay = async (
    token: string,
    order: {
      id: string;
      number: string;
      amountCents: number;
      currency: string;
    },
  ) => {
    const checkout = await http()
      .post(`/orders/${order.id}/payments`)
      .set(auth(token))
      .send({})
      .expect(200);
    expect(typeof checkout.body.payUrl).toBe('string');

    await notify(notificationFor(order));

    return (await getOrder(token, order.id).expect(200)).body;
  };

  const purchase = async (
    token: string,
    body: Record<string, unknown> = {},
  ) => {
    const created = await createOrder(token, body).expect(201);
    return pay(token, created.body);
  };

  const getSubscription = (token: string, id: string) =>
    http().get(`/subscriptions/${id}`).set(auth(token));

  const createTrial = (token: string, body: Record<string, unknown> = {}) =>
    http()
      .post('/subscriptions')
      .set(auth(token))
      .send({
        productCode: 'ai-platform',
        planCode: 'standard',
        interval: 'MONTH',
        trial: true,
        ...body,
      });

  const withinLeadWindow = (endsAt: string) =>
    new Date(new Date(endsAt).getTime() - 24 * 60 * 60 * 1000);

  const atBoundary = (endsAt: string) =>
    new Date(new Date(endsAt).getTime() + 1);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(SessionTokenService);
    orders = app.get(OrdersService);
  });

  beforeEach(async () => {
    notifySeq = 0;
    clock.reset();
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.refund.deleteMany();
    await prisma.paymentNotification.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.order.deleteMany();
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

  it('activates a subscription only after the payment callback', async () => {
    const { standardV1 } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createOrder(token, {}).expect(201);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.kind).toBe('NEW_SUBSCRIPTION');
    expect(created.body.amountCents).toBe(9900);
    expect(created.body.subscriptionId).toBeNull();

    // Nothing is granted while the order is unpaid.
    const before = await http()
      .get('/subscriptions')
      .set(auth(token))
      .expect(200);
    expect(before.body).toEqual([]);

    const paid = await pay(token, created.body);
    expect(paid.status).toBe('FULFILLED');
    expect(paid.subscriptionId).toBeTruthy();

    const subscription = await getSubscription(
      token,
      paid.subscriptionId,
    ).expect(200);
    expect(subscription.body).toMatchObject({
      productCode: 'ai-platform',
      status: 'ACTIVE',
    });
    expect(subscription.body.currentPeriod).toMatchObject({
      sequence: 1,
      kind: 'PAID',
      planCode: 'standard',
      planVersionId: standardV1.id,
      version: 1,
      interval: 'MONTH',
      unitPriceCents: 9900,
      currency: 'cny',
      maxActivations: 2,
    });
    expect(subscription.body.features).toEqual(['ai-credits']);
    expect(subscription.body.renewal).toMatchObject({
      source: 'PERIOD',
      version: 1,
      effectiveAt: subscription.body.currentPeriod.endsAt,
    });
  });

  it('reuses one checkout per product and applies a callback once', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createOrder(token, {}).expect(201);
    const duplicate = await createOrder(token, {}).expect(409);
    expect(duplicate.body.error.type).toBe('OrderAlreadyPending');

    await http()
      .post(`/orders/${created.body.id}/payments`)
      .set(auth(token))
      .send({})
      .expect(200);

    const notification = notificationFor(created.body);
    await notify(notification);
    // The provider retries until it gets `success`; the second call is a no-op.
    await notify(notification);

    const paid = await getOrder(token, created.body.id).expect(200);
    expect(paid.body.status).toBe('FULFILLED');

    const periods = await prisma.subscriptionPeriod.count({
      where: { subscriptionId: paid.body.subscriptionId },
    });
    expect(periods).toBe(1);

    const captured = await prisma.payment.count({
      where: { orderId: created.body.id, status: 'SUCCEEDED' },
    });
    expect(captured).toBe(1);

    const second = await createOrder(token, {}).expect(409);
    expect(second.body.error.type).toBe('SubscriptionAlreadyActive');
  });

  it('never grants anything when the paid amount does not match', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createOrder(token, {}).expect(201);
    await http()
      .post(`/orders/${created.body.id}/payments`)
      .set(auth(token))
      .send({})
      .expect(200);

    await notify(notificationFor(created.body, created.body.amountCents - 1));

    const order = await getOrder(token, created.body.id).expect(200);
    expect(order.body.status).toBe('PENDING');
    expect(order.body.subscriptionId).toBeNull();

    const notification = await prisma.paymentNotification.findFirstOrThrow({
      where: { orderId: created.body.id },
    });
    expect(notification.status).toBe('FAILED');
    expect(notification.errorMessage).toBe('AMOUNT_MISMATCH');
  });

  it('closes an unpaid checkout when it expires', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createOrder(token, {}).expect(201);
    const closed = await orders.expireOrders(
      new Date(Date.now() + 31 * 60_000),
    );
    expect(closed.closed).toBe(1);

    const order = await getOrder(token, created.body.id).expect(200);
    expect(order.body.status).toBe('CLOSED');

    // The slot is free again.
    await createOrder(token, {}).expect(201);
  });

  it('reconciles an unpaid order without granting anything', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createOrder(token, {}).expect(201);

    // The fake gateway has no record, so sync must not invent a payment.
    const response = await http()
      .post(`/orders/${created.body.id}/sync`)
      .set(auth(token))
      .expect(409);
    expect(response.body.error.type).toBe('PaymentNotConfirmed');

    const order = await getOrder(token, created.body.id).expect(200);
    expect(order.body.status).toBe('PENDING');
    expect(order.body.subscriptionId).toBeNull();
  });

  it('treats sync as a no-op when the order is already fulfilled', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);

    const synced = await http()
      .post(`/orders/${order.id}/sync`)
      .set(auth(token))
      .expect(200);
    expect(synced.body.status).toBe('FULFILLED');
    expect(synced.body.subscriptionId).toBe(order.subscriptionId);
  });

  it('starts a trial once and converts it at the pinned price', async () => {
    const { standard } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const trial = await createTrial(token).expect(201);
    expect(trial.body.status).toBe('TRIALING');
    expect(trial.body.currentPeriod).toMatchObject({
      kind: 'TRIAL',
      unitPriceCents: 9900,
      maxActivations: 1,
    });
    const trialEndsAt = trial.body.currentPeriod.endsAt as string;

    // A price change before conversion must not reach the running trial.
    await publish(standard.id, 2, { priceCents: 12900, trialDays: 30 });

    const renewal = await orders.createRenewalOrders(
      withinLeadWindow(trialEndsAt),
    );
    expect(renewal.created).toBe(1);

    const ordersList = await http().get('/orders').set(auth(token)).expect(200);
    const conversion = ordersList.body.find(
      (order: { kind: string }) => order.kind === 'TRIAL_CONVERSION',
    );
    expect(conversion).toMatchObject({
      status: 'PENDING',
      planVersionId: trial.body.currentPeriod.planVersionId,
      amountCents: 9900,
      appliesAt: trialEndsAt,
    });

    // Paying early records the money but must not open a second period.
    const paidEarly = await pay(token, conversion);
    expect(paidEarly.status).toBe('PAID');
    const stillTrialing = await getSubscription(token, trial.body.id).expect(
      200,
    );
    expect(stillTrialing.body.status).toBe('TRIALING');
    expect(stillTrialing.body.currentPeriod.id).toBe(
      trial.body.currentPeriod.id,
    );

    const settled = await orders.settleDueSubscriptions(
      atBoundary(trialEndsAt),
    );
    expect(settled.fulfilled).toBe(1);

    const converted = await getSubscription(token, trial.body.id).expect(200);
    expect(converted.body.status).toBe('ACTIVE');
    expect(converted.body.currentPeriod).toMatchObject({
      sequence: 2,
      kind: 'PAID',
      version: 1,
      unitPriceCents: 9900,
    });

    // The trial is spent even when the subscription later ends.
    const secondTrial = await createTrial(token).expect(409);
    expect(secondTrial.body.error.type).toBe('TrialAlreadyUsed');
  });

  it('settles a boundary the injected clock reports, via the admin job route', async () => {
    await seedCatalogue();
    const { token } = await signIn('clock-buyer@example.com');
    const { token: adminToken } = await signIn(
      'clock-admin@example.com',
      'ADMIN',
    );

    const trial = await createTrial(token).expect(201);
    const endsAt = trial.body.currentPeriod.endsAt as string;

    const runSettle = () =>
      http()
        .post('/admin/jobs/settle/run')
        .set(auth(adminToken))
        .send({ limit: 10 })
        .expect(200);

    // Before the boundary nothing is due, even though the request is served.
    const early = await runSettle();
    expect(early.body).toMatchObject({
      fulfilled: 0,
      canceled: 0,
      expired: 0,
    });

    // The job reads the injected clock, not the host clock: the same call now
    // sees the finished period and expires it.
    clock.set(atBoundary(endsAt));
    const settled = await runSettle();
    expect(settled.body.expired).toBe(1);

    const expired = await getSubscription(token, trial.body.id).expect(200);
    expect(expired.body.status).toBe('EXPIRED');
  });

  it('keeps renewing the pinned version after a new one is published', async () => {
    const { standard } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const endsAt = subscription.body.currentPeriod.endsAt as string;

    await publish(standard.id, 2, { priceCents: 12900 });

    const renewal = await orders.createRenewalOrders(withinLeadWindow(endsAt));
    expect(renewal.created).toBe(1);

    const pending = (
      await http().get('/orders').set(auth(token)).expect(200)
    ).body.find((row: { kind: string }) => row.kind === 'RENEWAL');
    expect(pending).toMatchObject({ amountCents: 9900, appliesAt: endsAt });

    await pay(token, pending);
    const settled = await orders.settleDueSubscriptions(atBoundary(endsAt));
    expect(settled.fulfilled).toBe(1);

    const renewed = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(renewed.body.currentPeriod).toMatchObject({
      sequence: 2,
      version: 1,
      unitPriceCents: 9900,
    });
  });

  it('expires a subscription whose renewal was not paid', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const endsAt = subscription.body.currentPeriod.endsAt as string;

    const settled = await orders.settleDueSubscriptions(atBoundary(endsAt));
    expect(settled.expired).toBe(1);

    const expired = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(expired.body.status).toBe('EXPIRED');
    expect(expired.body.currentPeriod).toMatchObject({
      closeReason: 'EXPIRED',
    });
  });

  it('sells the newest published version to a new customer', async () => {
    const { standard } = await seedCatalogue();
    const newcomer = await signIn('newcomer@example.com');

    const v2 = await publish(standard.id, 2, { priceCents: 12900 });
    const order = await purchase(newcomer.token);

    expect(order.planVersionId).toBe(v2.id);
    expect(order.amountCents).toBe(12900);
    const subscription = await getSubscription(
      newcomer.token,
      order.subscriptionId,
    ).expect(200);
    expect(subscription.body.currentPeriod).toMatchObject({
      version: 2,
      unitPriceCents: 12900,
    });
  });

  it('prices a scheduled upgrade into the renewal order', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const endsAt = subscription.body.currentPeriod.endsAt as string;

    await http()
      .post(`/subscriptions/${order.subscriptionId}/changes`)
      .set(auth(token))
      .send({ planCode: 'pro' })
      .expect(200);

    await orders.createRenewalOrders(withinLeadWindow(endsAt));
    const pending = (
      await http().get('/orders').set(auth(token)).expect(200)
    ).body.find((row: { kind: string }) => row.kind === 'RENEWAL');
    expect(pending).toMatchObject({
      planCode: 'pro',
      amountCents: 29900,
      appliesAt: endsAt,
    });

    await pay(token, pending);
    await orders.settleDueSubscriptions(atBoundary(endsAt));

    const upgraded = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(upgraded.body.currentPeriod).toMatchObject({
      sequence: 2,
      planCode: 'pro',
      unitPriceCents: 29900,
      maxActivations: 5,
    });
    expect(upgraded.body.pendingChange).toBeNull();
  });

  it('cancels at the period end without charging again', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const endsAt = subscription.body.currentPeriod.endsAt as string;

    const scheduled = await http()
      .post(`/subscriptions/${order.subscriptionId}/cancel`)
      .set(auth(token))
      .expect(200);
    expect(scheduled.body.pendingChange).toMatchObject({
      kind: 'CANCEL',
      effectiveAt: endsAt,
    });

    // A cancelled subscription must not get a renewal checkout.
    const renewal = await orders.createRenewalOrders(withinLeadWindow(endsAt));
    expect(renewal.created).toBe(0);

    const settled = await orders.settleDueSubscriptions(atBoundary(endsAt));
    expect(settled.canceled).toBe(1);

    const canceled = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(canceled.body.status).toBe('CANCELED');
    expect(canceled.body.currentPeriod).toMatchObject({
      closeReason: 'CANCELED',
    });
  });

  it('expires instead of renewing when the pinned version was retired', async () => {
    const { standardV1 } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const endsAt = subscription.body.currentPeriod.endsAt as string;

    await prisma.planVersion.update({
      where: { id: standardV1.id },
      data: { status: 'RETIRED', publishedKey: null, retiredAt: new Date() },
    });

    const renewal = await orders.createRenewalOrders(withinLeadWindow(endsAt));
    expect(renewal.created).toBe(0);

    const settled = await orders.settleDueSubscriptions(atBoundary(endsAt));
    expect(settled.expired).toBe(1);

    const expired = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(expired.body.status).toBe('EXPIRED');
  });

  it('pauses and resumes without moving the period window', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    const subscription = await getSubscription(
      token,
      order.subscriptionId,
    ).expect(200);
    const period = subscription.body.currentPeriod;

    const paused = await http()
      .post(`/subscriptions/${order.subscriptionId}/pause`)
      .set(auth(token))
      .expect(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(paused.body.currentPeriod).toMatchObject({
      id: period.id,
      endsAt: period.endsAt,
    });
    expect(paused.body.features).toEqual([]);

    const resumed = await http()
      .post(`/subscriptions/${order.subscriptionId}/resume`)
      .set(auth(token))
      .send({})
      .expect(200);
    expect(resumed.body.status).toBe('ACTIVE');
    expect(resumed.body.currentPeriod.id).toBe(period.id);
    expect(resumed.body.features).toEqual(['ai-credits']);
  });

  it('never resumes an ended or cancelled subscription into a free period', async () => {
    await seedCatalogue();
    const buyer = await signIn('buyer@example.com');
    const admin = await signIn('admin@example.com', 'ADMIN');

    const order = await purchase(buyer.token);
    const paused = await http()
      .post(`/subscriptions/${order.subscriptionId}/pause`)
      .set(auth(buyer.token))
      .expect(200);
    expect(paused.body.status).toBe('PAUSED');

    const period = await prisma.subscriptionPeriod.findFirstOrThrow({
      where: { subscriptionId: order.subscriptionId, status: 'ACTIVE' },
    });
    await prisma.subscriptionPeriod.update({
      where: { id: period.id },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });

    const expiredResume = await http()
      .post(`/subscriptions/${order.subscriptionId}/resume`)
      .set(auth(buyer.token))
      .expect(409);
    expect(expiredResume.body.error.type).toBe('SubscriptionExpired');
    expect(await prisma.subscriptionPeriod.count()).toBe(1);

    const settled = await orders.settleDueSubscriptions(new Date());
    expect(settled.expired).toBe(1);
    const expired = await getSubscription(
      buyer.token,
      order.subscriptionId,
    ).expect(200);
    expect(expired.body.status).toBe('EXPIRED');

    const lateResume = await http()
      .post(`/subscriptions/${order.subscriptionId}/resume`)
      .set(auth(buyer.token))
      .expect(409);
    expect(lateResume.body.error.type).toBe('SubscriptionNotActive');

    const second = await purchase(buyer.token);
    await http()
      .post(`/admin/subscriptions/${second.subscriptionId}/cancel`)
      .set(auth(admin.token))
      .expect(200);
    const cancelledResume = await http()
      .post(`/subscriptions/${second.subscriptionId}/resume`)
      .set(auth(buyer.token))
      .expect(409);
    expect(cancelledResume.body.error.type).toBe('SubscriptionNotActive');
  });

  it('records a capture after the grace window and lets an admin refund it', async () => {
    await seedCatalogue();
    const buyer = await signIn('buyer@example.com');
    const admin = await signIn('admin@example.com', 'ADMIN');

    const created = await createOrder(buyer.token, {}).expect(201);
    await http()
      .post(`/orders/${created.body.id}/payments`)
      .set(auth(buyer.token))
      .send({})
      .expect(200);

    await prisma.order.update({
      where: { id: created.body.id },
      data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const closed = await orders.expireOrders(new Date());
    expect(closed.closed).toBe(1);

    await notify(notificationFor(created.body));

    const late = await getOrder(buyer.token, created.body.id).expect(200);
    expect(late.body.status).toBe('CLOSED');
    expect(late.body.failureReason).toBe('LATE_PAYMENT');
    expect(late.body.payments[0]).toMatchObject({
      provider: 'ALIPAY',
      status: 'SUCCEEDED',
    });

    const refunded = await http()
      .post(`/orders/${created.body.id}/refunds`)
      .set(auth(admin.token))
      .send({ reason: 'late payment' })
      .expect(200);
    expect(refunded.body.status).toBe('REFUNDED');
    expect(refunded.body.refundedCents).toBe(created.body.amountCents);
    expect(await prisma.subscription.count()).toBe(0);
  });

  it('fulfils a capture just after expiry inside the grace window', async () => {
    await seedCatalogue();
    const buyer = await signIn('buyer@example.com');

    const created = await createOrder(buyer.token, {}).expect(201);
    await http()
      .post(`/orders/${created.body.id}/payments`)
      .set(auth(buyer.token))
      .send({})
      .expect(200);

    await prisma.order.update({
      where: { id: created.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await orders.expireOrders(new Date());

    await notify(notificationFor(created.body));

    const paid = await getOrder(buyer.token, created.body.id).expect(200);
    expect(paid.body.status).toBe('FULFILLED');
    expect(paid.body.subscriptionId).toBeTruthy();
  });

  it('refunds a captured payment and caps the amount', async () => {
    await seedCatalogue();
    const buyer = await signIn('buyer@example.com');
    const admin = await signIn('admin@example.com', 'ADMIN');

    const order = await purchase(buyer.token);

    await http()
      .post('/licensing/licenses/obtain')
      .set(auth(buyer.token))
      .send({ product: 'ai-platform', machineId: 'refund-machine' })
      .expect(200);

    // Only an administrator may move money back.
    await http()
      .post(`/orders/${order.id}/refunds`)
      .set(auth(buyer.token))
      .send({ reason: 'test' })
      .expect(403);

    const partial = await http()
      .post(`/orders/${order.id}/refunds`)
      .set(auth(admin.token))
      .send({ amountCents: 100, reason: 'goodwill' })
      .expect(200);
    expect(partial.body).toMatchObject({
      status: 'FULFILLED',
      refundedCents: 100,
    });

    // A partial refund leaves the entitlement untouched.
    await http()
      .post('/licensing/licenses/obtain')
      .set(auth(buyer.token))
      .send({ product: 'ai-platform', machineId: 'refund-machine' })
      .expect(200);

    const tooMuch = await http()
      .post(`/orders/${order.id}/refunds`)
      .set(auth(admin.token))
      .send({ amountCents: 9900, reason: 'too much' })
      .expect(422);
    expect(tooMuch.body.error.type).toBe('RefundExceedsPayment');

    const rest = await http()
      .post(`/orders/${order.id}/refunds`)
      .set(auth(admin.token))
      .send({ reason: 'full refund' })
      .expect(200);
    expect(rest.body.status).toBe('REFUNDED');
    expect(rest.body.refundedCents).toBe(9900);

    // The full refund of the order that opened the current period revokes it.
    const blocked = await http()
      .post('/licensing/licenses/obtain')
      .set(auth(buyer.token))
      .send({ product: 'ai-platform', machineId: 'refund-machine' })
      .expect(404);
    expect(blocked.body.error.type).toBe('NoActiveSubscription');

    const canceled = await getSubscription(
      buyer.token,
      order.subscriptionId,
    ).expect(200);
    expect(canceled.body.status).toBe('CANCELED');

    const activation = await prisma.deviceActivation.findFirst({
      where: { machineId: 'refund-machine' },
    });
    expect(activation?.activeKey).toBeNull();
  });

  it('isolates orders and subscriptions by owner', async () => {
    await seedCatalogue();
    const owner = await signIn('owner@example.com');
    const stranger = await signIn('stranger@example.com');

    const order = await purchase(owner.token);

    const orderResponse = await getOrder(stranger.token, order.id).expect(404);
    expect(orderResponse.body.error.type).toBe('OrderNotFound');

    const subscriptionResponse = await getSubscription(
      stranger.token,
      order.subscriptionId,
    ).expect(404);
    expect(subscriptionResponse.body.error.type).toBe('SubscriptionNotFound');

    await http().get('/orders').expect(401);
  });

  it('rejects callbacks from a provider it does not use', async () => {
    await seedCatalogue();

    const response = await http()
      .post('/payments/unknown/notify')
      .type('form')
      .send({ out_trade_no: 'unknown' })
      .expect(404);
    // The callback route answers text/plain, so the error envelope is a string.
    expect(response.text).toContain('PaymentProviderNotFound');
  });

  it('keeps the subscription state machine intact across a change', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const order = await purchase(token);
    await http()
      .post(`/subscriptions/${order.subscriptionId}/changes`)
      .set(auth(token))
      .send({ planCode: 'pro' })
      .expect(200);
    const conflict = await http()
      .post(`/subscriptions/${order.subscriptionId}/changes`)
      .set(auth(token))
      .send({ interval: 'YEAR' })
      .expect(409);
    expect(conflict.body.error.type).toBe('ChangeAlreadyPending');

    // The service method remains available for a cron job, but no automatic
    // renewal happens without money.
    const settled = await orders.settleDueSubscriptions(new Date('2099-01-01'));
    expect(settled.expired).toBe(1);
    const expired = await getSubscription(token, order.subscriptionId).expect(
      200,
    );
    expect(expired.body.status).toBe('EXPIRED');
  });
});
