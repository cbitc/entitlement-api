import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { FeatureValueType, PlanInterval, Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SessionTokenService } from '../src/auth/session-token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';

/**
 * Exercises the real MySQL test database, because the model leans on unique
 * keys and row locks that a mock would not reproduce.
 * Run `pnpm db:test:deploy` first.
 */
describe('Subscriptions (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let subscriptions: SubscriptionsService;
  let tokens: SessionTokenService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createSubscription = (token: string, body: Record<string, unknown>) =>
    http().post('/subscriptions').set(auth(token)).send(body);

  const getSubscription = (token: string, id: string) =>
    http().get(`/subscriptions/${id}`).set(auth(token));

  const signIn = async (email: string) => {
    const user = await prisma.user.create({
      data: { email, emailVerifiedAt: new Date() },
    });
    return { user, token: await tokens.issue(user) };
  };

  const createProduct = () =>
    prisma.product.create({
      data: { code: 'ai-platform', displayName: 'AI Platform' },
    });

  const createPlan = (productId: string, code: string) =>
    prisma.plan.create({
      data: { productId, code, displayName: code },
    });

  const createFeature = (
    code: string,
    valueType: FeatureValueType,
    consumable = false,
  ) =>
    prisma.feature.create({
      data: { code, displayName: code, valueType, unit: null, consumable },
    });

  const publish = async (
    planId: string,
    version: number,
    options: {
      priceCents?: number;
      trialDays?: number;
      maxActivations?: number;
      features?: ReadonlyArray<{
        featureId: string;
        value: Prisma.InputJsonValue;
      }>;
    } = {},
  ) => {
    // Only one version per plan may be PUBLISHED at a time.
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
            value: feature.value,
          })),
        },
      },
    });
  };

  /** A standard v1 (99/month, 30-day trial) and pro v1 (299/month). */
  const seedCatalogue = async () => {
    const product = await createProduct();
    const standard = await createPlan(product.id, 'standard');
    const pro = await createPlan(product.id, 'pro');
    const assistant = await createFeature('ai-assistant', 'BOOLEAN');
    const credits = await createFeature('ai-credits', 'NUMBER', true);

    const standardV1 = await publish(standard.id, 1, {
      priceCents: 9900,
      trialDays: 30,
      maxActivations: 2,
      features: [
        { featureId: assistant.id, value: false },
        { featureId: credits.id, value: 100 },
      ],
    });
    const proV1 = await publish(pro.id, 1, {
      priceCents: 29900,
      maxActivations: 5,
      features: [
        { featureId: assistant.id, value: true },
        { featureId: credits.id, value: 500 },
      ],
    });

    return { product, standard, pro, standardV1, proV1, assistant, credits };
  };

  /** Runs the renewal driver exactly at the boundary of the given period. */
  const renewAt = async (endsAt: string) =>
    subscriptions.renewDueSubscriptions(
      new Date(new Date(endsAt).getTime() + 1),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
    prisma = app.get(PrismaService);
    subscriptions = app.get(SubscriptionsService);
    tokens = app.get(SessionTokenService);
  });

  beforeEach(async () => {
    await prisma.entitlementUsage.deleteMany();
    await prisma.entitlementGrantItem.deleteMany();
    await prisma.entitlementGrant.deleteMany();
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

  it('creates a paid subscription pinned to the published version', async () => {
    const { standardV1 } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const response = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    const subscription = response.body;
    expect(subscription).toMatchObject({
      productCode: 'ai-platform',
      status: 'ACTIVE',
      pendingChange: null,
    });
    expect(subscription.currentPeriod).toMatchObject({
      sequence: 1,
      kind: 'PAID',
      planCode: 'standard',
      planVersionId: standardV1.id,
      version: 1,
      interval: 'MONTH',
      quantity: 1,
      unitPriceCents: 9900,
      currency: 'cny',
      maxActivations: 2,
      closeReason: null,
    });
    expect(subscription.renewal).toMatchObject({
      source: 'PERIOD',
      planCode: 'standard',
      version: 1,
      interval: 'MONTH',
      quantity: 1,
      effectiveAt: subscription.currentPeriod.endsAt,
    });
    expect(subscription.entitlements).toEqual(
      expect.arrayContaining([
        {
          code: 'ai-assistant',
          value: false,
          limit: null,
          used: 0,
          remaining: null,
        },
        { code: 'ai-credits', value: 100, limit: 100, used: 0, remaining: 100 },
      ]),
    );
  });

  it('refuses a second live subscription to the same product', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');
    const body = {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    };

    await createSubscription(token, body).expect(201);
    const conflict = await createSubscription(token, body).expect(409);

    expect(conflict.body.error.type).toBe('SubscriptionAlreadyActive');
  });

  it('starts a trial once per product and converts at the pinned terms', async () => {
    const { standard } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const trial = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
      trial: true,
    }).expect(201);

    expect(trial.body.status).toBe('TRIALING');
    expect(trial.body.currentPeriod).toMatchObject({
      kind: 'TRIAL',
      interval: 'MONTH',
      unitPriceCents: 9900,
      // The trial uses its own activation limit.
      maxActivations: 1,
    });

    // A price change before conversion must not reach the running trial.
    await publish(standard.id, 2, { priceCents: 12900, trialDays: 30 });

    await renewAt(trial.body.currentPeriod.endsAt);

    const converted = await getSubscription(token, trial.body.id).expect(200);
    expect(converted.body.status).toBe('ACTIVE');
    expect(converted.body.currentPeriod).toMatchObject({
      sequence: 2,
      kind: 'PAID',
      version: 1,
      interval: 'MONTH',
      unitPriceCents: 9900,
    });

    // Cancelling at the boundary releases the slot, and the trial stays spent.
    await http()
      .post(`/subscriptions/${trial.body.id}/cancel`)
      .set(auth(token))
      .expect(200);
    await renewAt(converted.body.currentPeriod.endsAt);

    const second = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
      trial: true,
    }).expect(409);
    expect(second.body.error.type).toBe('TrialAlreadyUsed');
  });

  it('keeps renewing the pinned version after a new one is published', async () => {
    const { standard } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    const v2 = await publish(standard.id, 2, { priceCents: 12900 });
    expect(v2.version).toBe(2);

    await renewAt(created.body.currentPeriod.endsAt);

    const renewed = await getSubscription(token, created.body.id).expect(200);
    expect(renewed.body.currentPeriod).toMatchObject({
      sequence: 2,
      version: 1,
      unitPriceCents: 9900,
    });
  });

  it('sells the newest published version to a new customer', async () => {
    const { standard } = await seedCatalogue();
    const { token } = await signIn('newcomer@example.com');

    await publish(standard.id, 2, { priceCents: 12900 });

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    expect(created.body.currentPeriod).toMatchObject({
      version: 2,
      unitPriceCents: 12900,
    });
  });

  it('applies a scheduled upgrade only at the period end', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);
    const endsAt = created.body.currentPeriod.endsAt as string;

    const scheduled = await http()
      .post(`/subscriptions/${created.body.id}/changes`)
      .set(auth(token))
      .send({ planCode: 'pro' })
      .expect(200);

    expect(scheduled.body.currentPeriod).toMatchObject({
      version: 1,
      unitPriceCents: 9900,
    });
    expect(scheduled.body.pendingChange).toMatchObject({
      kind: 'CHANGE',
      planCode: 'pro',
      version: 1,
      interval: 'MONTH',
      quantity: 1,
      effectiveAt: endsAt,
    });
    expect(scheduled.body.renewal).toMatchObject({
      source: 'CHANGE',
      planCode: 'pro',
      version: 1,
    });

    await renewAt(endsAt);

    const upgraded = await getSubscription(token, created.body.id).expect(200);
    expect(upgraded.body.currentPeriod).toMatchObject({
      sequence: 2,
      planCode: 'pro',
      version: 1,
      unitPriceCents: 29900,
      maxActivations: 5,
    });
    expect(upgraded.body.pendingChange).toBeNull();
  });

  it('cancels at the period end and lets the customer subscribe again', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);
    const endsAt = created.body.currentPeriod.endsAt as string;

    const scheduled = await http()
      .post(`/subscriptions/${created.body.id}/cancel`)
      .set(auth(token))
      .expect(200);

    expect(scheduled.body.pendingChange).toMatchObject({
      kind: 'CANCEL',
      effectiveAt: endsAt,
    });
    // Nothing is going to renew.
    expect(scheduled.body.renewal).toBeNull();

    await renewAt(endsAt);

    const canceled = await getSubscription(token, created.body.id).expect(200);
    expect(canceled.body.status).toBe('CANCELED');
    expect(canceled.body.currentPeriod).toMatchObject({
      closeReason: 'CANCELED',
    });

    await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'pro',
      interval: 'MONTH',
    }).expect(201);
  });

  it('expires at the period end when the pinned version is retired', async () => {
    const { standardV1 } = await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    await prisma.planVersion.update({
      where: { id: standardV1.id },
      data: { status: 'RETIRED', publishedKey: null, retiredAt: new Date() },
    });

    await renewAt(created.body.currentPeriod.endsAt);

    const expired = await getSubscription(token, created.body.id).expect(200);
    expect(expired.body.status).toBe('EXPIRED');
    expect(expired.body.currentPeriod).toMatchObject({
      closeReason: 'EXPIRED',
    });
  });

  it('pauses and resumes without moving the period window', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);
    const period = created.body.currentPeriod;

    const paused = await http()
      .post(`/subscriptions/${created.body.id}/pause`)
      .set(auth(token))
      .expect(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(paused.body.currentPeriod).toMatchObject({
      id: period.id,
      endsAt: period.endsAt,
    });
    // Entitlements are still visible while suspended.
    expect(paused.body.entitlements).toHaveLength(2);

    const resumed = await http()
      .post(`/subscriptions/${created.body.id}/resume`)
      .set(auth(token))
      .send({})
      .expect(200);
    expect(resumed.body.status).toBe('ACTIVE');
    expect(resumed.body.currentPeriod).toMatchObject({
      id: period.id,
      endsAt: period.endsAt,
    });

    const grant = await prisma.entitlementGrant.findFirstOrThrow({
      where: { subscriptionId: created.body.id },
    });
    expect(grant.status).toBe('ACTIVE');
  });

  it('rejects a second scheduled change and an unsigned-in caller', async () => {
    await seedCatalogue();
    const { token } = await signIn('buyer@example.com');

    const created = await createSubscription(token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    await http()
      .post(`/subscriptions/${created.body.id}/changes`)
      .set(auth(token))
      .send({ planCode: 'pro' })
      .expect(200);
    const conflict = await http()
      .post(`/subscriptions/${created.body.id}/changes`)
      .set(auth(token))
      .send({ interval: 'YEAR' })
      .expect(409);

    expect(conflict.body.error.type).toBe('ChangeAlreadyPending');

    await http().get('/subscriptions').expect(401);
  });

  it('hides another customer subscription behind a 404', async () => {
    await seedCatalogue();
    const owner = await signIn('owner@example.com');
    const stranger = await signIn('stranger@example.com');

    const created = await createSubscription(owner.token, {
      productCode: 'ai-platform',
      planCode: 'standard',
      interval: 'MONTH',
    }).expect(201);

    const response = await getSubscription(
      stranger.token,
      created.body.id,
    ).expect(404);
    expect(response.body.error.type).toBe('SubscriptionNotFound');
  });
});
