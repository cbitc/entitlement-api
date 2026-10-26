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
    planId: string,
    interval: PlanInterval,
    priceCents = 1000,
    currency = 'cny',
  ) =>
    prisma.planPrice.create({
      data: { planId, interval, priceCents, currency },
    });

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
    await prisma.planFeature.deleteMany();
    await prisma.feature.deleteMany();
    await prisma.planPrice.deleteMany();
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
    const pro = await createPlan(alpha.id, 'pro', {
      sortOrder: 20,
      maxActivations: 3,
      trialDays: 14,
      trialMaxActivations: 2,
    });
    await createPrice(standard.id, 'MONTH', 9900, 'usd');
    await createPrice(standard.id, 'MONTH', 9900, 'cny');
    await createPrice(pro.id, 'YEAR', 299_000);
    await createPrice(pro.id, 'MONTH', 29_900);

    const ai = await createFeature('ai-assistant');
    const projects = await createFeature('max-projects', 'NUMBER');
    // Inserted out of order on purpose: the response sorts by feature code.
    await prisma.planFeature.create({
      data: { planId: pro.id, featureId: projects.id, value: 100 },
    });
    await prisma.planFeature.create({
      data: { planId: pro.id, featureId: ai.id, value: true },
    });

    const betaPlan = await createPlan(beta.id, 'standard');
    await createPrice(betaPlan.id, 'MONTH', 500);

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
    expect(standardBody.trial).toBeNull();
    expect(standardBody.maxActivations).toBe(1);
    expect(standardBody.prices).toEqual([
      { interval: 'MONTH', priceCents: 9900, currency: 'cny' },
      { interval: 'MONTH', priceCents: 9900, currency: 'usd' },
    ]);

    const proBody = alphaBody.plans[1];
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

  it('hides inactive products, inactive plans and plans without a price', async () => {
    const inactiveProduct = await createProduct('inactive-product', {
      active: false,
    });
    const inactiveProductPlan = await createPlan(
      inactiveProduct.id,
      'standard',
    );
    await createPrice(inactiveProductPlan.id, 'MONTH');

    const unpriced = await createProduct('unpriced');
    await createPlan(unpriced.id, 'standard');

    const inactivePlan = await createProduct('inactive-plan');
    const retired = await createPlan(inactivePlan.id, 'standard', {
      active: false,
    });
    await createPrice(retired.id, 'MONTH');

    const priced = await createProduct('priced');
    const sellable = await createPlan(priced.id, 'standard');
    await createPrice(sellable.id, 'MONTH');

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
    await createPrice(plan.id, 'MONTH');

    const response = await getCatalog().expect(200);

    expect(response.body.products[0].tags).toEqual([]);
  });

  it('is readable without a session token', async () => {
    // Every request in this suite is unauthenticated, but state it once.
    await getCatalog().expect(200);
  });
});
