/**
 * Development seed for the catalogue.
 *
 * Idempotent: every row is upserted by its natural key, so running it twice
 * leaves the same data. It is a demo catalogue, not production content.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  {
    code: 'ai-assistant',
    displayName: 'AI Assistant',
    description: 'In-editor AI completions and chat.',
  },
  {
    code: 'code-insights',
    displayName: 'Code Insights',
    description: 'Project-wide inspections and dependency analysis.',
  },
  {
    code: 'team-sharing',
    displayName: 'Team Sharing',
    description: 'Share projects and settings with teammates.',
  },
];

const PRODUCTS = [
  {
    code: 'intellij-idea',
    displayName: 'IntelliJ IDEA',
    description: 'JVM IDE for Java, Kotlin and more.',
    vendor: 'JetBrains',
    websiteUrl: 'https://www.jetbrains.com/idea/',
    iconUrl: null,
    tags: ['ide', 'jvm'],
    sortOrder: 10,
    plans: [
      {
        code: 'standard',
        displayName: 'Standard',
        description: 'Everything you need for JVM development.',
        version: 1,
        maxActivations: 1,
        trialDays: 30,
        trialMaxActivations: 1,
        sortOrder: 10,
        prices: [
          { interval: 'MONTH', currency: 'cny', priceCents: 9900 },
          { interval: 'YEAR', currency: 'cny', priceCents: 99000 },
        ],
        features: ['code-insights'],
      },
      {
        code: 'pro',
        displayName: 'Pro',
        description: 'Standard plus AI assistance and more devices.',
        version: 1,
        maxActivations: 3,
        trialDays: 30,
        trialMaxActivations: 1,
        sortOrder: 20,
        prices: [
          { interval: 'MONTH', currency: 'cny', priceCents: 29900 },
          { interval: 'YEAR', currency: 'cny', priceCents: 299000 },
        ],
        features: ['ai-assistant', 'code-insights', 'team-sharing'],
      },
    ],
  },
];

const seedFeatures = async () => {
  const byCode = new Map();
  for (const feature of FEATURES) {
    const row = await prisma.feature.upsert({
      where: { code: feature.code },
      update: {
        displayName: feature.displayName,
        description: feature.description,
      },
      create: feature,
    });
    byCode.set(feature.code, row);
  }
  return byCode;
};

const seedProduct = async (product) => {
  const { plans, ...metadata } = product;
  const row = await prisma.product.upsert({
    where: { code: product.code },
    update: { ...metadata, active: true },
    create: { ...metadata, active: true },
  });
  return { row, plans };
};

const seedPlan = async (productId, plan, featuresByCode) => {
  const {
    prices,
    features,
    version: planVersion,
    maxActivations,
    trialDays,
    trialMaxActivations,
    ...metadata
  } = plan;
  const row = await prisma.plan.upsert({
    where: { productId_code: { productId, code: plan.code } },
    update: metadata,
    create: { ...metadata, productId },
  });

  const existing = await prisma.planVersion.findUnique({
    where: { planId_version: { planId: row.id, version: planVersion } },
  });
  // Published content is immutable: a demo change means bumping `version`.
  if (existing) {
    return;
  }

  const published = await prisma.planVersion.findFirst({
    where: { planId: row.id, status: 'PUBLISHED' },
    select: { id: true },
  });

  await prisma.planVersion.create({
    data: {
      planId: row.id,
      version: planVersion,
      status: published ? 'DRAFT' : 'PUBLISHED',
      publishedKey: published ? null : row.id,
      publishedAt: published ? null : new Date(),
      maxActivations,
      trialDays,
      trialMaxActivations,
      prices: {
        create: prices.map((price) => ({ ...price })),
      },
      features: {
        create: features.map((featureCode) => {
          const feature = featuresByCode.get(featureCode);
          if (!feature) {
            throw new Error(`Seed references unknown feature "${featureCode}"`);
          }
          return { featureId: feature.id };
        }),
      },
    },
  });
};

const main = async () => {
  const featuresByCode = await seedFeatures();

  for (const product of PRODUCTS) {
    const { row, plans } = await seedProduct(product);
    for (const plan of plans) {
      await seedPlan(row.id, plan, featuresByCode);
    }
    console.log(`Seeded product ${product.code} with ${plans.length} plans`);
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
