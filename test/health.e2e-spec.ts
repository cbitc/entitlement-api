import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';

describe('Health (e2e)', () => {
  let app: INestApplication;

  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ '1': 1 }]),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness and echoes a request id', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.name).toBe('entitlement-api');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('checks the database on readiness', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up' },
    });
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('returns 503 when the database is unreachable', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);

    expect(response.body).toEqual({
      error: {
        type: 'ServiceUnavailable',
        message: 'Database is not reachable',
      },
    });
  });

  it('renders unknown routes with the error envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);

    expect(response.body.error.type).toBe('NotFound');
    expect(typeof response.body.error.message).toBe('string');
  });
});
