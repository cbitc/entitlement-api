import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/infra/clock/clock';
import { FakeClock } from './support/fake-clock';
import { SessionTokenService } from '../src/auth/session-token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * The support console end to end: publishing a version must not disturb an
 * existing subscriber, disabling an account must bite on the next request, and
 * a callback payment must flow through the same fulfilment path.
 */
describe('Admin (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const signIn = async (
    email: string,
    role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER',
  ) => {
    const user = await prisma.user.create({
      data: { email, role, emailVerifiedAt: new Date() },
    });
    return { user, token: await tokens.issue(user) };
  };

  /** Product -> plan -> draft -> published, all through the admin API. */
  const createCatalogue = async (adminToken: string) => {
    await http()
      .post('/admin/features')
      .set(auth(adminToken))
      .send({ code: 'ai-assistant', displayName: 'AI Assistant' })
      .expect(201);

    const product = await http()
      .post('/admin/products')
      .set(auth(adminToken))
      .send({ code: 'admin-product', displayName: 'Admin Product' })
      .expect(201);

    const plan = await http()
      .post(`/admin/products/${product.body.id}/plans`)
      .set(auth(adminToken))
      .send({ code: 'standard', displayName: 'Standard' })
      .expect(201);

    const draft = await http()
      .post(`/admin/plans/${plan.body.id}/versions`)
      .set(auth(adminToken))
      .send({
        maxActivations: 2,
        trialDays: 30,
        trialMaxActivations: 1,
        prices: [{ interval: 'MONTH', priceCents: 9900 }],
        features: ['ai-assistant'],
      })
      .expect(201);

    const published = await http()
      .post(`/admin/versions/${draft.body.id}/publish`)
      .set(auth(adminToken))
      .expect(200);

    return {
      product: product.body,
      plan: plan.body,
      draft: draft.body,
      published: published.body,
    };
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
  });

  beforeEach(async () => {
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

  it('refuses non-administrators', async () => {
    const customer = await signIn('customer@example.com');

    const response = await http()
      .get('/admin/users')
      .set(auth(customer.token))
      .expect(403);
    expect(response.body.error.type).toBe('Forbidden');
  });

  it('publishes a new version without disturbing an existing subscriber', async () => {
    const admin = await signIn('admin@example.com', 'ADMIN');
    const buyer = await signIn('buyer@example.com');
    const { plan, published } = await createCatalogue(admin.token);

    const trial = await http()
      .post('/subscriptions')
      .set(auth(buyer.token))
      .send({
        productCode: 'admin-product',
        planCode: 'standard',
        interval: 'MONTH',
        trial: true,
      })
      .expect(201);
    expect(trial.body.currentPeriod.planVersionId).toBe(published.id);

    const next = await http()
      .post(`/admin/plans/${plan.id}/versions`)
      .set(auth(admin.token))
      .send({
        copyFromVersionId: published.id,
        prices: [{ interval: 'MONTH', priceCents: 12900 }],
      })
      .expect(201);
    await http()
      .post(`/admin/versions/${next.body.id}/publish`)
      .set(auth(admin.token))
      .expect(200);

    // The old version is grandfathered, never edited.
    const versions = await http()
      .get(`/admin/plans/${plan.id}/versions`)
      .set(auth(admin.token))
      .expect(200);
    const old = versions.body.find(
      (version: { id: string }) => version.id === published.id,
    );
    expect(old).toMatchObject({
      status: 'CLOSED_FOR_SALE',
      prices: [{ interval: 'MONTH', currency: 'cny', priceCents: 9900 }],
    });

    // The running subscription still pins v1 and keeps its features.
    const stillRunning = await http()
      .get(`/subscriptions/${trial.body.id}`)
      .set(auth(buyer.token))
      .expect(200);
    expect(stillRunning.body.currentPeriod.planVersionId).toBe(published.id);
    expect(stillRunning.body.features).toEqual(['ai-assistant']);

    // The shop now sells v2.
    const catalog = await http().get('/catalog').expect(200);
    expect(catalog.body.products[0].plans[0].planVersionId).toBe(next.body.id);
  });

  it('shows the buyer and a scheduled cancellation on the admin views', async () => {
    const admin = await signIn('admin@example.com', 'ADMIN');
    const buyer = await signIn('buyer@example.com');
    await createCatalogue(admin.token);

    const trial = await http()
      .post('/subscriptions')
      .set(auth(buyer.token))
      .send({
        productCode: 'admin-product',
        planCode: 'standard',
        interval: 'MONTH',
        trial: true,
      })
      .expect(201);

    await http()
      .post(`/subscriptions/${trial.body.id}/cancel`)
      .set(auth(buyer.token))
      .expect(200);

    const view = await http()
      .get(`/admin/subscriptions/${trial.body.id}`)
      .set(auth(admin.token))
      .expect(200);
    expect(view.body).toMatchObject({
      userId: buyer.user.id,
      userEmail: 'buyer@example.com',
      pendingChange: { kind: 'CANCEL' },
      renewal: null,
    });
    expect(typeof view.body.productId).toBe('string');

    const page = await http()
      .get('/admin/subscriptions')
      .query({ userId: buyer.user.id })
      .set(auth(admin.token))
      .expect(200);
    expect(page.body.items[0].userEmail).toBe('buyer@example.com');
  });

  it('enforces the version state machine', async () => {
    const admin = await signIn('admin@example.com', 'ADMIN');
    const { plan, published } = await createCatalogue(admin.token);

    await http()
      .patch(`/admin/versions/${published.id}`)
      .set(auth(admin.token))
      .send({ maxActivations: 5 })
      .expect(409);

    await http()
      .post(`/admin/versions/${published.id}/retire`)
      .set(auth(admin.token))
      .expect(409);

    await http()
      .post(`/admin/versions/${published.id}/close-for-sale`)
      .set(auth(admin.token))
      .expect(200);
    const retired = await http()
      .post(`/admin/versions/${published.id}/retire`)
      .set(auth(admin.token))
      .expect(200);
    expect(retired.body.status).toBe('RETIRED');

    await http()
      .delete(`/admin/versions/${published.id}`)
      .set(auth(admin.token))
      .expect(409);

    const draft = await http()
      .post(`/admin/plans/${plan.id}/versions`)
      .set(auth(admin.token))
      .send({ prices: [{ interval: 'YEAR', priceCents: 99000 }] })
      .expect(201);
    await http()
      .delete(`/admin/versions/${draft.body.id}`)
      .set(auth(admin.token))
      .expect(204);
  });

  it('disables an account and invalidates its live session', async () => {
    const admin = await signIn('admin@example.com', 'ADMIN');
    const user = await signIn('user@example.com');

    const listed = await http()
      .get('/admin/users?email=user@example.com')
      .set(auth(admin.token))
      .expect(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items).toHaveLength(1);

    await http()
      .patch(`/admin/users/${user.user.id}`)
      .set(auth(admin.token))
      .send({ status: 'DISABLED' })
      .expect(200);
    await http().get('/users/me').set(auth(user.token)).expect(401);

    await http()
      .patch(`/admin/users/${user.user.id}`)
      .set(auth(admin.token))
      .send({ status: 'ACTIVE' })
      .expect(200);
    await http().get('/users/me').set(auth(user.token)).expect(200);

    const selfDisable = await http()
      .patch(`/admin/users/${admin.user.id}`)
      .set(auth(admin.token))
      .send({ status: 'DISABLED' })
      .expect(409);
    expect(selfDisable.body.error.type).toBe('CannotDisableSelf');
  });

  it('fulfils a callback payment, unbinds a device and ends the contract now', async () => {
    const admin = await signIn('admin@example.com', 'ADMIN');
    const buyer = await signIn('buyer@example.com');
    await createCatalogue(admin.token);

    const order = await http()
      .post('/orders')
      .set(auth(buyer.token))
      .send({
        productCode: 'admin-product',
        planCode: 'standard',
        interval: 'MONTH',
      })
      .expect(201);

    await http()
      .post(`/orders/${order.body.id}/payments`)
      .set(auth(buyer.token))
      .send({})
      .expect(200);

    const callback = {
      out_trade_no: order.body.number,
      trade_status: 'TRADE_SUCCESS',
      trade_no: `T-${order.body.number}`,
      total_amount: '99.00',
      currency: 'cny',
      gmt_payment: new Date().toISOString(),
    };

    await http()
      .post('/payments/alipay/notify')
      .type('form')
      .send({ ...callback, notify_id: `N-${order.body.id}-1` })
      .expect(200);

    const paid = await http()
      .get(`/admin/orders/${order.body.id}`)
      .set(auth(admin.token))
      .expect(200);
    expect(paid.body).toMatchObject({
      status: 'FULFILLED',
      kind: 'NEW_SUBSCRIPTION',
      userId: buyer.user.id,
      userEmail: 'buyer@example.com',
    });
    expect(paid.body.payments[0]).toMatchObject({
      provider: 'ALIPAY',
      status: 'SUCCEEDED',
    });

    // Replaying the callback must not buy a second period.
    await http()
      .post('/payments/alipay/notify')
      .type('form')
      .send({ ...callback, notify_id: `N-${order.body.id}-2` })
      .expect(200);
    const again = await http()
      .get(`/admin/orders/${order.body.id}`)
      .set(auth(admin.token))
      .expect(200);
    expect(again.body.subscriptionId).toBe(paid.body.subscriptionId);
    expect(await prisma.subscriptionPeriod.count()).toBe(1);

    const obtained = await http()
      .post('/licensing/licenses/obtain')
      .set(auth(buyer.token))
      .send({ product: 'admin-product', machineId: 'machine-a' })
      .expect(200);
    expect(obtained.body.features).toEqual(['ai-assistant']);

    const licenses = await http()
      .get('/admin/licenses?product=admin-product')
      .set(auth(admin.token))
      .expect(200);
    expect(licenses.body.total).toBe(1);
    const activationId = licenses.body.items[0].activations[0].id;

    await http()
      .post(`/admin/activations/${activationId}/deactivate`)
      .set(auth(admin.token))
      .expect(204);

    const canceled = await http()
      .post(`/admin/subscriptions/${paid.body.subscriptionId}/cancel`)
      .set(auth(admin.token))
      .expect(200);
    expect(canceled.body.status).toBe('CANCELED');

    await http()
      .post('/licensing/licenses/obtain')
      .set(auth(buyer.token))
      .send({ product: 'admin-product', machineId: 'machine-a' })
      .expect(404);

    const settle = await http()
      .post('/admin/jobs/settle/run')
      .set(auth(admin.token))
      .send({ limit: 10 })
      .expect(200);
    expect(settle.body).toMatchObject({
      fulfilled: 0,
      canceled: 0,
      expired: 0,
      failed: 0,
    });
  });
});
