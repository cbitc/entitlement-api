import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { importJWK, jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SessionTokenService } from '../src/auth/session-token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Licensing is derived from the subscription's ACTIVE period and grant, so a
 * real MySQL is needed for row locks and the unique activation key.
 * Run `pnpm db:test:deploy` first.
 */
describe('Licensing (e2e)', () => {
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

  const seedCatalogue = async () => {
    const product = await prisma.product.create({
      data: { code: 'licensing-product', displayName: 'Licensing Product' },
    });
    const plan = await prisma.plan.create({
      data: {
        productId: product.id,
        code: 'standard',
        displayName: 'Standard',
      },
    });
    const ai = await prisma.feature.create({
      data: { code: 'ai-assistant', displayName: 'AI Assistant' },
    });
    const insights = await prisma.feature.create({
      data: { code: 'code-insights', displayName: 'Code Insights' },
    });
    const version = await prisma.planVersion.create({
      data: {
        planId: plan.id,
        version: 1,
        status: 'PUBLISHED',
        publishedKey: plan.id,
        publishedAt: new Date(),
        maxActivations: 2,
        trialDays: 30,
        trialMaxActivations: 2,
        prices: {
          create: [{ interval: 'MONTH', currency: 'cny', priceCents: 9900 }],
        },
        features: {
          create: [{ featureId: ai.id }, { featureId: insights.id }],
        },
      },
    });
    return { product, plan, version };
  };

  const startTrial = (token: string) =>
    http().post('/subscriptions').set(auth(token)).send({
      productCode: 'licensing-product',
      planCode: 'standard',
      interval: 'MONTH',
      trial: true,
    });

  const obtain = (
    token: string,
    machineId: string,
    path = '/licensing/licenses/obtain',
  ) =>
    http()
      .post(path)
      .set(auth(token))
      .send({ product: 'licensing-product', machineId });

  const deactivate = (token: string, machineId: string) =>
    http()
      .post('/licensing/licenses/deactivate')
      .set(auth(token))
      .send({ product: 'licensing-product', machineId });

  const getJwks = () => http().get('/.well-known/jwks.json');

  const verify = async (token: string) => {
    const jwks = await getJwks().expect(200);
    const [jwk] = jwks.body.keys;
    const key = await importJWK(jwk, 'EdDSA');
    return jwtVerify(token, key, {
      issuer: 'entitlement-api',
      audience: 'entitlement-client',
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(SessionTokenService);
  });

  beforeEach(async () => {
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

  it('issues a verifiable token and enforces the activation limit', async () => {
    await seedCatalogue();
    const { user, token } = await signIn('licensing@example.com');
    const trial = await startTrial(token).expect(201);

    const first = await obtain(token, 'machine-a').expect(200);
    expect(first.body).toMatchObject({
      plan: 'standard',
      trial: true,
      features: ['ai-assistant', 'code-insights'],
    });
    expect(typeof first.body.token).toBe('string');

    const jwks = await getJwks().expect(200);
    expect(jwks.headers['cache-control']).toBe('public, max-age=300');
    expect(jwks.body.keys).toHaveLength(1);
    expect(jwks.body.keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
    });
    expect(jwks.body.keys[0]).not.toHaveProperty('d');

    const { payload, protectedHeader } = await verify(first.body.token);
    expect(protectedHeader).toMatchObject({ alg: 'EdDSA' });
    expect(payload).toMatchObject({
      sub: user.id,
      product: 'licensing-product',
      plan: 'standard',
      trial: true,
      features: ['ai-assistant', 'code-insights'],
      machineId: 'machine-a',
    });
    expect(payload.exp).toBe(
      Math.floor(new Date(first.body.expiresAt).getTime() / 1000),
    );
    expect(new Date(first.body.expiresAt).getTime()).toBeLessThanOrEqual(
      new Date(trial.body.currentPeriod.endsAt).getTime(),
    );

    // Re-obtaining for the same machine refreshes, never consumes a slot.
    const refreshed = await obtain(token, 'machine-a').expect(200);
    expect(refreshed.body.plan).toBe('standard');

    await obtain(token, 'machine-b').expect(200);

    const exceeded = await obtain(token, 'machine-c').expect(409);
    expect(exceeded.body.error.type).toBe('ActivationLimitExceeded');

    const licenses = await http()
      .get('/licensing/licenses')
      .set(auth(token))
      .expect(200);
    expect(licenses.body.licenses).toHaveLength(1);
    expect(licenses.body.licenses[0]).toMatchObject({
      product: 'licensing-product',
      plan: 'standard',
      trial: true,
      status: 'TRIALING',
      maxActivations: 2,
      features: ['ai-assistant', 'code-insights'],
    });
    expect(licenses.body.licenses[0].activations).toHaveLength(2);
  });

  it('releases an activation slot and allows another machine', async () => {
    await seedCatalogue();
    const { token } = await signIn('deactivate@example.com');
    await startTrial(token).expect(201);

    await obtain(token, 'machine-a').expect(200);
    await obtain(token, 'machine-b').expect(200);

    await deactivate(token, 'machine-a').expect(204);
    await deactivate(token, 'machine-a').expect(404);

    await obtain(token, 'machine-c').expect(200);

    const licenses = await http()
      .get('/licensing/licenses')
      .set(auth(token))
      .expect(200);
    expect(
      licenses.body.licenses[0].activations.map(
        (activation: { machineId: string }) => activation.machineId,
      ),
    ).toEqual(['machine-b', 'machine-c']);
  });

  it('refuses a paused subscription and allows it again after resume', async () => {
    await seedCatalogue();
    const { token } = await signIn('paused@example.com');
    const trial = await startTrial(token).expect(201);

    await obtain(token, 'machine-a').expect(200);

    await http()
      .post(`/subscriptions/${trial.body.id}/pause`)
      .set(auth(token))
      .expect(200);

    const refused = await obtain(token, 'machine-a').expect(404);
    expect(refused.body.error.type).toBe('NoActiveSubscription');

    // A paused subscription is still a license the user can see, just not use.
    const pausedList = await http()
      .get('/licensing/licenses')
      .set(auth(token))
      .expect(200);
    expect(pausedList.body.licenses).toHaveLength(1);
    expect(pausedList.body.licenses[0]).toMatchObject({ status: 'PAUSED' });

    await http()
      .post(`/subscriptions/${trial.body.id}/resume`)
      .set(auth(token))
      .send({})
      .expect(200);

    await obtain(token, 'machine-a').expect(200);
  });

  it('issues an offline token capped by the period end', async () => {
    await seedCatalogue();
    const { token } = await signIn('offline@example.com');
    const trial = await startTrial(token).expect(201);

    const offline = await obtain(
      token,
      'machine-a',
      '/licensing/licenses/offline',
    ).expect(200);

    const { payload } = await verify(offline.body.token);
    expect(payload.offline).toBe(true);
    expect(new Date(offline.body.expiresAt).getTime()).toBeLessThanOrEqual(
      new Date(trial.body.currentPeriod.endsAt).getTime(),
    );
  });

  it('lets an administrator list the licenses of an account', async () => {
    await seedCatalogue();
    const { user, token } = await signIn('admin-target@example.com');
    const admin = await signIn('admin@example.com', 'ADMIN');
    await startTrial(token).expect(201);
    await obtain(token, 'machine-a').expect(200);

    await http()
      .get(`/admin/licenses?email=${encodeURIComponent(user.email)}`)
      .set(auth(token))
      .expect(403);

    const listed = await http()
      .get(`/admin/licenses?email=${encodeURIComponent(user.email)}`)
      .set(auth(admin.token))
      .expect(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      userEmail: user.email,
      product: 'licensing-product',
      plan: 'standard',
      features: ['ai-assistant', 'code-insights'],
    });
    expect(listed.body.items[0].activations).toHaveLength(1);
  });

  it('validates the request body and reports unknown products', async () => {
    await seedCatalogue();
    const { token } = await signIn('invalid@example.com');
    await startTrial(token).expect(201);

    const invalid = await http()
      .post('/licensing/licenses/obtain')
      .set(auth(token))
      .send({ machineId: 'machine-a' })
      .expect(400);
    expect(invalid.body.error.type).toBe('ValidationError');

    const unknown = await http()
      .post('/licensing/licenses/obtain')
      .set(auth(token))
      .send({ product: 'missing', machineId: 'machine-a' })
      .expect(404);
    expect(unknown.body.error.type).toBe('NoActiveSubscription');
  });
});
