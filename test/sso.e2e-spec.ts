import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../src/infra/clock/clock';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { FakeClock } from './support/fake-clock';
import {
  FakeOidcProvider,
  type FakeIdentity,
} from './support/fake-oidc-provider';

const CLIENT_ID = 'entitlement-api';
const CLIENT_SECRET = 'test-only-sso-client-secret';
const REDIRECT_URI = 'http://localhost:3000/auth/sso/callback';
const WEB_APP_URL = 'http://localhost:5173';
const EMAIL = 'buyer@example.com';

/**
 * Drives the real OIDC journey against a local provider that signs real
 * id_tokens: discovery, JWKS, token exchange, PKCE and nonce checks all run.
 */
describe('SSO (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  let idp: FakeOidcProvider;
  let ipCounter = 0;

  const http = () => request(app.getHttpServer());

  /**
   * Every test gets its own forwarded address so the per-IP throttler buckets
   * stay isolated; `trust proxy` makes the guard see the header.
   */
  const createApi = () => {
    ipCounter += 1;
    const ip = `10.2.0.${ipCounter}`;
    const withIp = <T extends { set(field: string, value: string): T }>(
      builder: T,
    ) => builder.set('X-Forwarded-For', ip);

    return {
      start: (returnTo: string) =>
        withIp(http().get('/auth/sso/start')).query({ returnTo }),
      callback: (code: string, state: string, cookie?: string) => {
        const builder = withIp(http().get('/auth/sso/callback')).query({
          code,
          state,
        });
        return cookie ? builder.set('Cookie', cookie) : builder;
      },
      exchange: (ticket: string) =>
        withIp(http().post('/auth/sso/exchange')).send({ ticket }),
      me: (token: string) =>
        withIp(http().get('/users/me')).set('Authorization', `Bearer ${token}`),
    };
  };

  type Api = ReturnType<typeof createApi>;

  const stateCookie = (setCookie: string | string[] | undefined): string => {
    const list = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    const cookie = list.find((value) => value.startsWith('sso_state='));
    if (!cookie) {
      throw new Error('the response did not set a sso_state cookie');
    }
    return cookie.split(';')[0] ?? '';
  };

  const startLogin = async (api: Api, returnTo = '/subscriptions') => {
    const response = await api.start(returnTo).expect(302).redirects(0);
    const location = new URL(response.headers.location as string);
    return {
      state: location.searchParams.get('state') ?? '',
      nonce: location.searchParams.get('nonce') ?? '',
      codeChallenge: location.searchParams.get('code_challenge') ?? '',
      cookie: stateCookie(response.headers['set-cookie']),
    };
  };

  /** Runs start �?IdP �?callback and returns the callback redirect. */
  const completeLogin = async (
    api: Api,
    identity: Partial<FakeIdentity> = {},
    cookieOverride?: string,
  ) => {
    const login = await startLogin(api);
    const code = idp.mintCode({
      nonce: login.nonce,
      codeChallenge: login.codeChallenge,
      ...identity,
    });
    return api
      .callback(code, login.state, cookieOverride ?? login.cookie)
      .expect(302)
      .redirects(0);
  };

  const redirectTarget = (response: {
    headers: Record<string, string | string[] | undefined>;
  }): URL => new URL(response.headers.location as string);

  /** Full journey, ending with a session token. */
  const signIn = async (api: Api, identity: Partial<FakeIdentity> = {}) => {
    const callback = await completeLogin(api, identity);
    const target = redirectTarget(callback);
    const ticket = target.searchParams.get('ticket');
    if (!ticket) {
      throw new Error(`callback did not return a ticket: ${target.toString()}`);
    }
    const exchanged = await api.exchange(ticket).expect(200);
    return { token: exchanged.body.token as string, target, callback };
  };

  beforeAll(async () => {
    idp = new FakeOidcProvider(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    await idp.start();

    // Configuration is validated when `ConfigModule.forRoot` is evaluated,
    // which happens at module import time: set everything before importing.
    process.env.SSO_ISSUER = idp.issuer;
    process.env.SSO_CLIENT_ID = CLIENT_ID;
    process.env.SSO_CLIENT_SECRET = CLIENT_SECRET;
    process.env.SSO_REDIRECT_URI = REDIRECT_URI;
    process.env.WEB_APP_URL = WEB_APP_URL;

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(new FakeClock())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    await app.init();
    prisma = app.get(PrismaService);
    clock = app.get(Clock) as FakeClock;
  });

  beforeEach(async () => {
    await prisma.outboundNotification.deleteMany();
    await prisma.jobRun.deleteMany();
    await prisma.jobLock.deleteMany();
    await prisma.loginTicket.deleteMany();
    await prisma.externalIdentity.deleteMany();
    await prisma.user.deleteMany();
    clock.reset();
  });

  afterAll(async () => {
    await app.close();
    await idp.stop();
  });

  it('creates the account on first sign-in and returns a usable session', async () => {
    const api = createApi();
    const { token, target } = await signIn(api);

    expect(target.origin).toBe(WEB_APP_URL);
    expect(target.pathname).toBe('/auth/callback');
    expect(target.searchParams.get('next')).toBe('/subscriptions');

    const me = await api.me(token).expect(200);
    expect(me.body).toMatchObject({
      email: EMAIL,
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
    expect(me.body.emailVerifiedAt).toBeTypeOf('string');

    const identity = await prisma.externalIdentity.findFirst();
    expect(identity).toMatchObject({
      provider: 'oidc',
      subject: 'subject-1',
      email: EMAIL,
    });
  });

  it('reuses the same account on later sign-ins', async () => {
    const api = createApi();
    const first = await signIn(api);
    const second = await signIn(api);

    const [a, b] = await Promise.all([
      api.me(first.token).expect(200),
      api.me(second.token).expect(200),
    ]);

    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.externalIdentity.count()).toBe(1);
  });

  it('links an existing account by verified email instead of duplicating it', async () => {
    const existing = await prisma.user.create({
      data: {
        email: EMAIL,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        lastLoginAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    const api = createApi();
    const { token } = await signIn(api);
    const me = await api.me(token).expect(200);

    expect(me.body.id).toBe(existing.id);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.externalIdentity.count()).toBe(1);
  });

  it('refuses an unverified address', async () => {
    const api = createApi();
    const callback = await completeLogin(api, { emailVerified: false });

    const target = redirectTarget(callback);
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('error')).toBe('SsoEmailNotVerified');
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses a disabled account', async () => {
    await prisma.user.create({
      data: { email: EMAIL, status: 'DISABLED', emailVerifiedAt: new Date() },
    });

    const api = createApi();
    const callback = await completeLogin(api);

    const target = redirectTarget(callback);
    expect(target.searchParams.get('error')).toBe('AccountDisabled');
    expect(await prisma.loginTicket.count()).toBe(0);
  });

  it('rejects a callback that the same browser did not start', async () => {
    const api = createApi();
    const login = await startLogin(api);
    const code = idp.mintCode({
      nonce: login.nonce,
      codeChallenge: login.codeChallenge,
    });

    const response = await api
      .callback(code, login.state)
      .expect(302)
      .redirects(0);

    expect(redirectTarget(response).searchParams.get('error')).toBe(
      'InvalidSsoState',
    );
  });

  it('rejects an id_token minted for another login attempt', async () => {
    const api = createApi();
    const callback = await completeLogin(api, {
      nonce: 'nonce-from-another-browser',
    });

    expect(redirectTarget(callback).searchParams.get('error')).toBe(
      'SsoTokenInvalid',
    );
    expect(await prisma.user.count()).toBe(0);
  });

  it('drops a returnTo that points outside the portal', async () => {
    const api = createApi();
    const login = await startLogin(api, 'https://evil.example/steal');
    const code = idp.mintCode({
      nonce: login.nonce,
      codeChallenge: login.codeChallenge,
    });

    const callback = await api
      .callback(code, login.state, login.cookie)
      .expect(302)
      .redirects(0);

    expect(redirectTarget(callback).searchParams.get('next')).toBe('/');
  });

  it('refuses to redeem the same ticket twice', async () => {
    const api = createApi();
    const callback = await completeLogin(api);
    const ticket = redirectTarget(callback).searchParams.get('ticket') ?? '';

    await api.exchange(ticket).expect(200);
    const replay = await api.exchange(ticket).expect(401);
    expect(replay.body.error.type).toBe('InvalidLoginTicket');
  });

  it('expires an unused ticket', async () => {
    const api = createApi();
    const callback = await completeLogin(api);
    const ticket = redirectTarget(callback).searchParams.get('ticket') ?? '';

    clock.advance(5 * 60_000);
    const expired = await api.exchange(ticket).expect(410);
    expect(expired.body.error.type).toBe('LoginTicketExpired');
  });

  it('no longer exposes the email-code endpoints', async () => {
    await http().post('/auth/request-login').send({ email: EMAIL }).expect(404);
    await http()
      .post('/auth/verify-login')
      .send({ email: EMAIL, code: '123456' })
      .expect(404);
  });
});
