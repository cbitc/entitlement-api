import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/infra/clock/clock';
import { FakeClock } from './support/fake-clock';
import { SessionTokenService } from '../src/auth/session-token.service';
import { AppConfig } from '../src/config/app-config.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { JobLockService } from '../src/scheduling/job-lock.service';
import { JobRunnerService } from '../src/scheduling/job-runner.service';

/**
 * Timers stay off in tests; the runner is exercised directly so the lease and
 * the run history can be asserted without sleeping. Run
 * `pnpm db:test:deploy` first.
 */
describe('Scheduled job runner (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;
  let jobs: JobRunnerService;
  let lock: JobLockService;

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
    jobs = app.get(JobRunnerService);
    lock = app.get(JobLockService);

    expect(app.get(AppConfig).schedulerEnabled).toBe(false);
  });

  beforeEach(async () => {
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.verificationCode.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('records a run and skips when another process holds the lease', async () => {
    const first = await jobs.run('settle', { limit: 10, source: 'admin' });
    expect(first.status).toBe('SUCCEEDED');
    expect(first.result).toMatchObject({
      fulfilled: 0,
      canceled: 0,
      expired: 0,
      failed: 0,
    });

    const acquired = await lock.acquire('settle', 'test-holder', 60_000);
    expect(acquired).toBe(true);
    try {
      const skipped = await jobs.run('settle', {
        limit: 10,
        source: 'admin',
      });
      expect(skipped.status).toBe('SKIPPED');
      expect(skipped.result).toEqual({ skipped: true });
    } finally {
      await lock.release('settle', 'test-holder');
    }

    expect(
      await prisma.jobRun.count({
        where: { name: 'settle', status: 'SUCCEEDED' },
      }),
    ).toBe(1);
    expect(
      await prisma.jobRun.count({
        where: { name: 'settle', status: 'SKIPPED' },
      }),
    ).toBe(1);

    const succeeded = await prisma.jobRun.findFirstOrThrow({
      where: { name: 'settle', status: 'SUCCEEDED' },
    });
    expect(succeeded.durationMs).not.toBeNull();
    expect(succeeded.finishedAt).not.toBeNull();
  });

  it('does not record an empty scheduled run', async () => {
    const outcome = await jobs.run('settle', {
      limit: 10,
      source: 'scheduler',
    });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.runId).toBeNull();
    expect(await prisma.jobRun.count({ where: { name: 'settle' } })).toBe(0);
  });

  it('lets only one of two concurrent acquires win without throwing', async () => {
    const first = `${hostname()}:${process.pid}:${randomUUID()}`;
    const second = `${hostname()}:${process.pid}:${randomUUID()}`;

    const results = await Promise.all([
      lock.acquire('settle', first, 60_000),
      lock.acquire('settle', second, 60_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const lease = await lock.inspect('settle');
    expect(lease).not.toBeNull();
    if (lease) {
      await lock.release('settle', lease.owner);
    }
    expect(await prisma.jobLock.count({ where: { name: 'settle' } })).toBe(0);
  });

  it('reclaims a lease left by a dead local process and deletes it on release', async () => {
    const deadOwner = `${hostname()}:2147483647:${randomUUID()}`;
    expect(await lock.acquire('settle', deadOwner, 60_000)).toBe(true);

    const liveOwner = `${hostname()}:${process.pid}:${randomUUID()}`;
    expect(await lock.acquire('settle', liveOwner, 60_000)).toBe(true);

    const lease = await lock.inspect('settle');
    expect(lease?.owner).toBe(liveOwner);
    expect(await lock.extend('settle', liveOwner, 60_000)).toBe(true);

    await lock.release('settle', liveOwner);
    expect(await prisma.jobLock.count({ where: { name: 'settle' } })).toBe(0);
  });

  it('lets an admin trigger the notification dispatcher and read run history', async () => {
    const { token } = await signIn('ops@example.com', 'ADMIN');

    const dispatch = await http()
      .post('/admin/jobs/notifications/run')
      .set(auth(token))
      .send({ limit: 10 })
      .expect(200);
    expect(dispatch.body).toMatchObject({ sent: 0, retried: 0, failed: 0 });

    const runs = await http()
      .get('/admin/jobs/runs')
      .query({ name: 'notifications' })
      .set(auth(token))
      .expect(200);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0]).toMatchObject({
      name: 'notifications',
      status: 'SUCCEEDED',
    });
  });
});
