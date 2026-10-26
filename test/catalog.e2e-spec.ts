import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PlanInterval, Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';

describe('Catalog (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const getCatalog = () => request(app.getHttpServer()).get('/catalog');

  const createProduct = (
    code: string,
    data: Partial<
      Omit<Prisma.ProductUncheckedCreateInput, 'code' | 'displayName'>
    > = {},
  ) => prisma.product.create({ data: { code, displayName: code, ...data } });

  const createPlan = (
    productId: string,
    code: string,
    data: Partial<
      Omit<
        Prisma.PlanUncheckedCreateInput,
        'productId' | 'code' | 'displayName'
      >
    > = {},
  ) =>
    prisma.plan.create({
      data: { productId, code, displayName: code, ...data },
    });

  const createPrice = (
    planVersionId: string,
    interval: PlanInterval,
    priceCents = 1000,
    currency = 'cny',
  ) =>
    prisma.planVersionPrice.create({
      data: { planVersionId, interval, priceCents, currency },
    });

  const createVersion = (
    planId: string,
    version = 1,
    data: Partial<
      Omit<Prisma.PlanVersionUncheckedCreateInput, 'planId' | 'version'>
    > = {},
  ) => {
    const status = data.status ?? 'PUBLISHED';
    return prisma.planVersion.create({
      data: {
        planId,
        version,
        status,
        publishedKey: status === 'PUBLISHED' ? planId : null,
        ...data,
      },
    });
  };

  const createFeature = (
    code: string,
    valueType: 'BOOLEAN' | 'NUMBER' | 'TEXT' = 'BOOLEAN',
  ) => prisma.feature.create({ data: { code, displayName: code, valueType } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
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
    await prisma.feature.deleteMany();
    await prisma.planVersionPrice.deleteMany();
    await prisma.planVersion.deleteMany();
    await prisma.plan.deleteMany();
    await prisma.product.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists sellable products with plans, terms, trials and entitlements', async () => {
    const beta = await createProduct('beta', { sortOrder: 20 });
    const alpha = await createProduct('alpha', {
      sortOrder: 10,
      vendor: 'Acme',
      tags: ['ide', 'tools'],
    });

    const standard = await createPlan(alpha.id, 'standard', { sortOrder: 10 });
    const pro = await createPlan(alpha.id, 'pro', { sortOrder: 20 });
    const standardV1 = await createVersion(standard.id);
    const proV1 = await createVersion(pro.id, 1, {
      maxActivations: 3,
      trialDays: 14,
      trialMaxActivations: 2,
    });
    await createPrice(standardV1.id, 'MONTH', 9900, 'usd');
    await createPrice(standardV1.id, 'MONTH', 9900, 'cny');
    await createPrice(proV1.id, 'YEAR', 299_000);
    await createPrice(proV1.id, 'MONTH', 29_900);

    const ai = await createFeature('ai-assistant');
    const projects = await createFeature('max-projects', 'NUMBER');
    // Inserted out of order on purpose: the response sorts by feature code.
    await prisma.planVersionFeature.create({
      data: { planVersionId: proV1.id, featureId: projects.id, value: 100 },
    });
    await prisma.planVersionFeature.create({
      data: { planVersionId: proV1.id, featureId: ai.id, value: true },
    });

    const betaPlan = await createPlan(beta.id, 'standard');
    const betaV1 = await createVersion(betaPlan.id);
    await createPrice(betaV1.id, 'MONTH', 500);

    const response = await getCatalog().expect(200);

    expect(response.body.products.map((p: { code: string }) => p.code)).toEqual(
      ['alpha', 'beta'],
    );

    const alphaBody = response.body.products[0];
    expect(alphaBody).toMatchObject({
      code: 'alpha',
      vendor: 'Acme',
      tags: ['ide', 'tools'],
      sortOrder: 10,
    });
    expect(alphaBody.plans.map((plan: { code: string }) => plan.code)).toEqual([
      'standard',
      'pro',
    ]);

    const standardBody = alphaBody.plans[0];
    expect(standardBody.planVersionId).toBe(standardV1.id);
    expect(standardBody.version).toBe(1);
    expect(standardBody.trial).toBeNull();
    expect(standardBody.maxActivations).toBe(1);
    expect(standardBody.prices).toEqual([
      { interval: 'MONTH', priceCents: 9900, currency: 'cny' },
      { interval: 'MONTH', priceCents: 9900, currency: 'usd' },
    ]);

    const proBody = alphaBody.plans[1];
    expect(proBody.planVersionId).toBe(proV1.id);
    expect(proBody.version).toBe(1);
    expect(proBody.maxActivations).toBe(3);
    expect(proBody.trial).toEqual({ days: 14, maxActivations: 2 });
    expect(proBody.prices).toEqual([
      { interval: 'MONTH', priceCents: 29_900, currency: 'cny' },
      { interval: 'YEAR', priceCents: 299_000, currency: 'cny' },
    ]);
    expect(proBody.features).toEqual([
      { code: 'ai-assistant', value: true },
      { code: 'max-projects', value: 100 },
    ]);
  });

  it('hides inactive products, plans without a sellable version and versions without a price', async () => {
    const inactiveProduct = await createProduct('inactive-product', {
      active: false,
    });
    const inactiveProductPlan = await createPlan(
      inactiveProduct.id,
      'standard',
    );
    const inactiveProductVersion = await createVersion(inactiveProductPlan.id);
    await createPrice(inactiveProductVersion.id, 'MONTH');

    const unpriced = await createProduct('unpriced');
    await createPlan(unpriced.id, 'standard');

    // A DRAFT version is not for sale, even when it has a price.
    const drafted = await createProduct('draft-only');
    const draftPlan = await createPlan(drafted.id, 'standard');
    const draftVersion = await createVersion(draftPlan.id, 1, {
      status: 'DRAFT',
    });
    await createPrice(draftVersion.id, 'MONTH');

    const priced = await createProduct('priced');
    const sellable = await createPlan(priced.id, 'standard');
    const sellableVersion = await createVersion(sellable.id);
    await createPrice(sellableVersion.id, 'MONTH');

    const response = await getCatalog().expect(200);

    expect(response.body.products.map((p: { code: string }) => p.code)).toEqual(
      ['priced'],
    );
    expect(response.body.products[0].plans).toHaveLength(1);
  });

  it('returns an empty list when nothing is sellable', async () => {
    const product = await createProduct('empty');
    await createPlan(product.id, 'standard');

    const response = await getCatalog().expect(200);

    expect(response.body).toEqual({ products: [] });
  });

  it('treats a product without tags as an empty list', async () => {
    const product = await createProduct('plain');
    const plan = await createPlan(product.id, 'standard');
    const version = await createVersion(plan.id);
    await createPrice(version.id, 'MONTH');

    const response = await getCatalog().expect(200);

    expect(response.body.products[0].tags).toEqual([]);
  });

  it('is readable without a session token', async () => {
    // Every request in this suite is unauthenticated, but state it once.
    await getCatalog().expect(200);
  });
});
