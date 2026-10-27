import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.service';
import { LicenseTokenService } from './license-token.service';

const makeConfig = (overrides: Partial<AppConfig['license']> = {}): AppConfig =>
  ({
    isProduction: false,
    license: {
      privateKey: '',
      kid: 'test-kid',
      issuer: 'entitlement-api',
      audience: 'entitlement-client',
      tokenTtlSeconds: 3600,
      offlineTtlDays: 30,
      ...overrides,
    },
  }) as unknown as AppConfig;

const issueInput = (expiresAt: Date) => ({
  userId: 'user-1',
  product: 'ide',
  plan: 'pro',
  trial: true,
  machineId: 'machine-a',
  offline: false,
  expiresAt,
});

describe('LicenseTokenService', () => {
  it('publishes a public JWK without the private scalar', async () => {
    const service = new LicenseTokenService(makeConfig());
    await service.onModuleInit();

    const [key] = service.jwks().keys;
    expect(key).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: 'test-kid',
      alg: 'EdDSA',
      use: 'sig',
    });
    expect(key).not.toHaveProperty('d');
  });

  it('signs claims that verify against the published JWK', async () => {
    const service = new LicenseTokenService(makeConfig());
    await service.onModuleInit();

    const now = new Date('2026-10-27T00:00:00.000Z');
    const issued = await service.issue(
      { ...issueInput(new Date('2027-01-01T00:00:00.000Z')), offline: true },
      now,
    );

    const jwk = service.jwks().keys[0]!;
    const key = await importJWK(jwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(issued.token, key, {
      issuer: 'entitlement-api',
      audience: 'entitlement-client',
      currentDate: now,
    });

    expect(protectedHeader).toMatchObject({
      alg: 'EdDSA',
      kid: 'test-kid',
    });
    expect(payload).toMatchObject({
      sub: 'user-1',
      product: 'ide',
      plan: 'pro',
      trial: true,
      machineId: 'machine-a',
      offline: true,
    });
    expect(payload.exp).toBe(
      Math.floor(now.getTime() / 1000) + 30 * 24 * 60 * 60,
    );
  });

  it('caps the token at the grant expiry', async () => {
    const service = new LicenseTokenService(makeConfig());
    await service.onModuleInit();

    const now = new Date('2026-10-27T00:00:00.000Z');
    const grantEndsAt = new Date(now.getTime() + 60_000);
    const issued = await service.issue(issueInput(grantEndsAt), now);

    expect(issued.expiresAt).toEqual(grantEndsAt);
    const jwk = service.jwks().keys[0]!;
    const { payload } = await jwtVerify(
      issued.token,
      await importJWK(jwk, 'EdDSA'),
      {
        issuer: 'entitlement-api',
        audience: 'entitlement-client',
        currentDate: now,
      },
    );
    expect(payload.exp).toBe(Math.floor(grantEndsAt.getTime() / 1000));
  });
});
