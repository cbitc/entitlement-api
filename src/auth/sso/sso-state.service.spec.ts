import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.service';
import {
  sanitizeReturnTo,
  SsoStateService,
  type SsoState,
} from './sso-state.service';

const ISSUER = 'entitlement-api';
const SECRET = 'test-only-jwt-secret-with-32-characters';

const config = {
  jwtIssuer: ISSUER,
  sso: { stateTtlSeconds: 600 },
} as unknown as AppConfig;

const createService = (): SsoStateService =>
  new SsoStateService(
    new JwtService({ secret: SECRET, signOptions: { issuer: ISSUER } }),
    config,
  );

const state: SsoState = {
  nonce: 'nonce-1',
  codeVerifier: 'verifier-1',
  returnTo: '/subscriptions',
};

describe('SsoStateService', () => {
  it('round-trips the login attempt', async () => {
    const service = createService();

    await expect(service.verify(await service.issue(state))).resolves.toEqual(
      state,
    );
  });

  it('rejects a state signed for another audience', async () => {
    const service = createService();
    const foreign = await new JwtService({ secret: SECRET }).signAsync(state, {
      issuer: ISSUER,
      audience: 'entitlement-api',
    });

    await expect(service.verify(foreign)).rejects.toMatchObject({
      type: 'InvalidSsoState',
    });
  });

  it('rejects a tampered state', async () => {
    const service = createService();
    const token = await service.issue(state);
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature ?? ''}x`;

    await expect(service.verify(tampered)).rejects.toMatchObject({
      type: 'InvalidSsoState',
    });
  });

  it('rejects a token that is not a state at all', async () => {
    await expect(createService().verify('not-a-jwt')).rejects.toMatchObject({
      type: 'InvalidSsoState',
    });
  });
});

describe('sanitizeReturnTo', () => {
  it('keeps a same-site path', () => {
    expect(sanitizeReturnTo('/subscriptions?tab=licenses')).toBe(
      '/subscriptions?tab=licenses',
    );
  });

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash trick', '/\\evil.example'],
    ['an empty value', ''],
  ])('drops %s', (_label, value) => {
    expect(sanitizeReturnTo(value)).toBe('/');
  });

  it('drops an over-long path', () => {
    expect(sanitizeReturnTo(`/${'a'.repeat(600)}`)).toBe('/');
  });
});
