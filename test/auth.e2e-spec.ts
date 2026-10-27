import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module';
import { Mailer, type LoginCodeMail } from '../src/infra/mail/mailer';
import { PrismaService } from '../src/infra/prisma/prisma.service';

const EMAIL = 'buyer@example.com';
const OTHER_EMAIL = 'other@example.com';

/**
 * Exercises the real MySQL test database: the login flow relies on a
 * transaction, a compare-and-set and unique keys, which a mocked client would
 * not reproduce. Run `pnpm db:test:deploy` first.
 */
describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const sent: LoginCodeMail[] = [];
  const mailer = {
    sendLoginCode: vi.fn(async (mail: LoginCodeMail) => {
      sent.push(mail);
    }),
  };

  /**
   * Each test uses its own client IP so the per-IP throttler counters stay
   * isolated; `trust proxy` lets the guard see the forwarded address.
   */
  const createApi = (ip: string) => {
    const http = () => request(app.getHttpServer());
    const withIp = <T extends { set(field: string, value: string): T }>(
      builder: T,
    ) => builder.set('X-Forwarded-For', ip);

    return {
      requestLogin: (email = EMAIL) =>
        withIp(http().post('/auth/request-login')).send({ email }),
      verifyLogin: (code: string, email = EMAIL) =>
        withIp(http().post('/auth/verify-login')).send({ email, code }),
      getMe: (token: string) =>
        withIp(http().get('/users/me')).set('Authorization', `Bearer ${token}`),
      patchMe: (token: string, body: Record<string, unknown>) =>
        withIp(http().patch('/users/me'))
          .set('Authorization', `Bearer ${token}`)
          .send(body),
    };
  };

  type Api = ReturnType<typeof createApi>;

  /** Resend throttling is per address; age the rows instead of waiting. */
  const ageVerificationCodes = () =>
    prisma.verificationCode.updateMany({
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });

  const lastCode = (): string => {
    const code = sent.at(-1)?.code;
    if (!code) {
      throw new Error('the mail transport did not capture a login code');
    }
    return code;
  };

  const login = async (api: Api): Promise<string> => {
    await api.requestLogin().expect(202);
    const response = await api.verifyLogin(lastCode()).expect(200);
    return response.body.token as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Mailer)
      .useValue(mailer)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    sent.length = 0;
    mailer.sendLoginCode.mockClear();
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.verificationCode.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends a code and creates the account on first login', async () => {
    const api = createApi('10.1.0.1');

    const issued = await api.requestLogin('Buyer@Example.com ').expect(202);
    expect(issued.body.email).toBe(EMAIL);
    expect(Number.isNaN(Date.parse(issued.body.expiresAt))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(EMAIL);

    const verified = await api.verifyLogin(lastCode()).expect(200);
    expect(typeof verified.body.token).toBe('string');

    const me = await api.getMe(verified.body.token).expect(200);
    expect(me.body).toMatchObject({
      email: EMAIL,
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
    expect(me.body.emailVerifiedAt).toBeTypeOf('string');
  });

  it('reuses the same account on a later login', async () => {
    const api = createApi('10.1.0.2');

    const firstToken = await login(api);
    await ageVerificationCodes();
    const secondToken = await login(api);

    const [first, second] = await Promise.all([
      api.getMe(firstToken).expect(200),
      api.getMe(secondToken).expect(200),
    ]);

    expect(first.body.id).toBe(second.body.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects an incorrect code and burns an attempt', async () => {
    const api = createApi('10.1.0.3');

    await api.requestLogin().expect(202);
    const wrong = lastCode() === '000000' ? '111111' : '000000';

    const response = await api.verifyLogin(wrong).expect(401);
    expect(response.body.error.type).toBe('InvalidVerificationCode');

    const record = await prisma.verificationCode.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    expect(record?.attemptsRemaining).toBe(4);
  });

  it('reports a missing code as 404', async () => {
    const api = createApi('10.1.0.4');

    const response = await api.verifyLogin('123456', OTHER_EMAIL).expect(404);
    expect(response.body.error.type).toBe('VerificationNotFound');
  });

  it('throttles resends for the same address', async () => {
    const api = createApi('10.1.0.5');

    await api.requestLogin().expect(202);
    const response = await api.requestLogin().expect(429);

    expect(response.body.error.type).toBe('TooManyRequests');
    expect(sent).toHaveLength(1);
  });

  it('allows a resend when the clock moved backwards', async () => {
    const api = createApi('10.1.0.9');
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationCode.create({
      data: {
        email: EMAIL,
        codeHash: '0'.repeat(64),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdAt: future,
        attemptsRemaining: 5,
      },
    });

    await api.requestLogin().expect(202);
    expect(sent).toHaveLength(1);

    const pending = await prisma.verificationCode.count({
      where: { email: EMAIL, consumedAt: null },
    });
    expect(pending).toBe(1);
  });

  it('refuses a disabled account and invalidates its token', async () => {
    const api = createApi('10.1.0.6');

    const token = await login(api);
    await prisma.user.updateMany({ data: { status: 'DISABLED' } });
    await ageVerificationCodes();

    await api.requestLogin().expect(202);
    const response = await api.verifyLogin(lastCode()).expect(403);
    expect(response.body.error.type).toBe('AccountDisabled');

    await api.getMe(token).expect(401);
  });

  it('requires a bearer token', async () => {
    const api = createApi('10.1.0.7');

    const response = await api.getMe('').expect(401);
    expect(response.body.error.type).toBe('Unauthorized');
  });

  it('updates the display name', async () => {
    const api = createApi('10.1.0.8');

    const token = await login(api);
    const response = await api
      .patchMe(token, { displayName: '  Aiden  ' })
      .expect(200);

    expect(response.body.displayName).toBe('Aiden');
  });

  it('rejects an invalid email address', async () => {
    const api = createApi('10.1.0.9');

    const response = await api.requestLogin('not-an-email').expect(400);
    expect(response.body.error.type).toBe('ValidationError');
  });
});
