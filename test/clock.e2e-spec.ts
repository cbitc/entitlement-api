import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SessionTokenService } from '../src/auth/session-token.service';
import { ClockControl } from '../src/infra/clock/clock-control.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * `test/setup.ts` turns `CLOCK_CONTROL_ENABLED` on for the e2e project: the
 * flag is read while the environment is validated at module import time, so it
 * cannot be toggled per suite. The disabled path is covered by the unit test
 * for `ClockControl`.
 */
const createTables = async (prisma: PrismaService): Promise<void> => {
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
};

describe('Application clock control (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;
  let control: ClockControl;

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

  const setClock = (token: string, body: Record<string, unknown>) =>
    http().post('/admin/clock').set(auth(token)).send(body);

  const seedCatalogue = async (): Promise<void> => {
    const product = await prisma.product.create({
      data: { code: 'clock-app', displayName: 'Clock App' },
    });
    const plan = await prisma.plan.create({
      data: {
        productId: product.id,
        code: 'standard',
        displayName: 'Standard',
      },
    });
    await prisma.planVersion.create({
      data: {
        planId: plan.id,
        version: 1,
        status: 'PUBLISHED',
        publishedKey: plan.id,
        publishedAt: new Date(),
        trialDays: 14,
        prices: {
          create: [{ interval: 'MONTH', currency: 'cny', priceCents: 9900 }],
        },
      },
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
    control = app.get(ClockControl);
  });

  beforeEach(async () => {
    control.reset();
    await createTables(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is administrator only', async () => {
    await http().get('/admin/clock').expect(401);

    const customer = await signIn('clock-customer@example.com');
    await http().get('/admin/clock').set(auth(customer.token)).expect(403);
    await setClock(customer.token, { reset: true }).expect(403);
  });

  it('reports the wall clock until somebody moves it', async () => {
    const admin = await signIn('clock-admin@example.com', 'ADMIN');

    const response = await http()
      .get('/admin/clock')
      .set(auth(admin.token))
      .expect(200);

    expect(response.body).toMatchObject({
      enabled: true,
      controlled: false,
      offsetMs: 0,
      pinnedAt: null,
    });
    const driftMs = Math.abs(
      new Date(response.body.now).getTime() -
        new Date(response.body.realNow).getTime(),
    );
    expect(driftMs).toBeLessThan(5_000);
  });

  it('pins, shifts, advances and resets', async () => {
    const admin = await signIn('clock-admin@example.com', 'ADMIN');
    const pinned = '2027-03-01T00:00:00.000Z';

    const pinnedState = await setClock(admin.token, { now: pinned }).expect(
      200,
    );
    expect(pinnedState.body).toMatchObject({
      controlled: true,
      now: pinned,
      pinnedAt: pinned,
      offsetMs: 0,
    });

    // Advancing from a pin moves the pin, it does not start the wall clock.
    const advanced = await http()
      .post('/admin/clock/advance')
      .set(auth(admin.token))
      .send({ hours: 2, minutes: 30 })
      .expect(200);
    expect(advanced.body.now).toBe('2027-03-01T02:30:00.000Z');
    expect(advanced.body.pinnedAt).toBe('2027-03-01T02:30:00.000Z');

    // A shift keeps the clock running relative to the wall clock.
    const shifted = await setClock(admin.token, {
      offsetMs: 7 * 24 * 60 * 60 * 1000,
    }).expect(200);
    expect(shifted.body.pinnedAt).toBeNull();
    expect(shifted.body.offsetMs).toBe(604_800_000);
    const shiftDrift =
      new Date(shifted.body.now).getTime() -
      new Date(shifted.body.realNow).getTime();
    expect(Math.abs(shiftDrift - 604_800_000)).toBeLessThan(5_000);

    const reset = await setClock(admin.token, { reset: true }).expect(200);
    expect(reset.body).toMatchObject({
      controlled: false,
      offsetMs: 0,
      pinnedAt: null,
    });
  });

  it('rejects ambiguous or empty instructions', async () => {
    const admin = await signIn('clock-admin@example.com', 'ADMIN');

    await setClock(admin.token, {}).expect(400);
    await setClock(admin.token, {
      now: '2027-03-01T00:00:00.000Z',
      reset: true,
    }).expect(400);
    await http()
      .post('/admin/clock/advance')
      .set(auth(admin.token))
      .send({})
      .expect(400);
  });

  it('lets a job settle a boundary the clock reports', async () => {
    await seedCatalogue();
    const admin = await signIn('clock-admin@example.com', 'ADMIN');
    const customer = await signIn('clock-customer@example.com');

    const trial = await http()
      .post('/subscriptions')
      .set(auth(customer.token))
      .send({
        productCode: 'clock-app',
        planCode: 'standard',
        interval: 'MONTH',
        trial: true,
      })
      .expect(201);
    const endsAt = new Date(trial.body.currentPeriod.endsAt as string);

    const runSettle = () =>
      http()
        .post('/admin/jobs/settle/run')
        .set(auth(admin.token))
        .send({ limit: 10 })
        .expect(200);

    const early = await runSettle();
    expect(early.body.expired).toBe(0);

    // One second past the boundary, reported through the admin API only: no
    // database row was edited to make this happen.
    await setClock(admin.token, {
      now: new Date(endsAt.getTime() + 1_000).toISOString(),
    }).expect(200);

    const settled = await runSettle();
    expect(settled.body.expired).toBe(1);

    const view = await http()
      .get(`/subscriptions/${trial.body.id}`)
      .set(auth(customer.token))
      .expect(200);
    expect(view.body.status).toBe('EXPIRED');
  });
});
