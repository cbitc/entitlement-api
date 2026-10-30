import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SessionTokenService } from '../src/auth/session-token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';

const EMAIL = 'buyer@example.com';

/**
 * The session guard is independent of how a session was obtained. Login itself
 * is covered by `sso.e2e-spec.ts`; these cases pin down what the guard does
 * with a token after it was issued.
 */
describe('Session guard (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tokens: SessionTokenService;
  let jwt: JwtService;

  const http = () => request(app.getHttpServer());

  const signIn = async (email = EMAIL) => {
    const user = await prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        lastLoginAt: new Date(),
      },
    });
    return { user, token: await tokens.issue(user) };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(SessionTokenService);
    jwt = app.get(JwtService);
  });

  beforeEach(async () => {
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.loginTicket.deleteMany();
    await prisma.externalIdentity.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request without a bearer token', async () => {
    const response = await http().get('/users/me').expect(401);
    expect(response.body.error.type).toBe('Unauthorized');
  });

  it('resolves the caller from the token subject', async () => {
    const { user, token } = await signIn();

    const response = await http()
      .get('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: user.id,
      email: EMAIL,
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
  });

  it('lets the caller update their display name', async () => {
    const { token } = await signIn();

    const response = await http()
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Renamed Buyer' })
      .expect(200);

    expect(response.body.displayName).toBe('Renamed Buyer');
  });

  it('drops access as soon as the account is disabled', async () => {
    const { user, token } = await signIn();

    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'DISABLED' },
    });

    const response = await http()
      .get('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body.error.type).toBe('Unauthorized');
  });

  it('rejects a token minted for another audience', async () => {
    const { user } = await signIn();
    const foreign = await jwt.signAsync(
      { email: EMAIL, role: 'CUSTOMER' },
      { subject: user.id, audience: 'another-api' },
    );

    await http()
      .get('/users/me')
      .set('Authorization', `Bearer ${foreign}`)
      .expect(401);
  });
});
