import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const baseEnv = {
  DATABASE_URL: 'mysql://entitlement:entitlement@localhost:3306/entitlement',
  JWT_SECRET: 'test-only-jwt-secret-with-32-characters',
};

const productionEnv = {
  ...baseEnv,
  NODE_ENV: 'production',
  SMTP_HOST: 'smtp.example.com',
  ALIPAY_APP_ID: '2026000000000000',
  ALIPAY_PRIVATE_KEY: 'private-key',
  ALIPAY_PUBLIC_KEY: 'public-key',
  LICENSE_JWT_PRIVATE_KEY: 'test-license-key',
  SSO_ISSUER: 'https://idp.example/realms/entitlement',
  SSO_CLIENT_SECRET: 'test-only-sso-client-secret',
  SSO_REDIRECT_URI: 'https://api.example/auth/sso/callback',
};

describe('validateEnv', () => {
  it('applies development defaults', () => {
    const env = validateEnv(baseEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_FORMAT).toBe('pretty');
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('disables the scheduler only in tests or on request', () => {
    expect(validateEnv(baseEnv).SCHEDULER_ENABLED).toBe(true);
    expect(
      validateEnv({ ...baseEnv, NODE_ENV: 'test' }).SCHEDULER_ENABLED,
    ).toBe(false);
    expect(
      validateEnv({ ...baseEnv, SCHEDULER_ENABLED: 'false' }).SCHEDULER_ENABLED,
    ).toBe(false);
  });

  it('logs successful requests unless explicitly silenced', () => {
    expect(validateEnv(baseEnv).LOG_HTTP_SUCCESS).toBe(true);
    expect(
      validateEnv({ ...baseEnv, LOG_HTTP_SUCCESS: 'false' }).LOG_HTTP_SUCCESS,
    ).toBe(false);
  });

  it('coerces numbers and splits comma separated origins', () => {
    const env = validateEnv({
      ...baseEnv,
      PORT: '8080',
      THROTTLE_LIMIT: '25',
      CORS_ORIGINS: 'https://a.example, https://b.example ,',
    });

    expect(env.PORT).toBe(8080);
    expect(env.THROTTLE_LIMIT).toBe(25);
    expect(env.CORS_ORIGINS).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('ignores a pretty log format in production', () => {
    const env = validateEnv({
      ...productionEnv,
      LOG_FORMAT: 'pretty',
      SWAGGER_ENABLED: 'true',
    });

    expect(env.LOG_FORMAT).toBe('json');
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('disables swagger in production by default', () => {
    const env = validateEnv(productionEnv);

    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('rejects a non-MySQL datasource', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'postgresql://localhost:5432/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('reports every missing required key', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL: /);
  });

  it('rejects a wildcard origin in production', () => {
    expect(() =>
      validateEnv({
        ...productionEnv,
        CORS_ORIGINS: '*',
      }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('defaults the SSO relying-party settings', () => {
    const env = validateEnv(baseEnv);

    expect(env.SSO_ISSUER).toBe('http://localhost:8080/realms/entitlement');
    expect(env.SSO_CLIENT_ID).toBe('entitlement-api');
    expect(env.SSO_STATE_TTL_SECONDS).toBe(600);
    expect(env.SSO_TICKET_TTL_SECONDS).toBe(60);
    expect(env.SSO_ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });

  it('splits the allowed email domains', () => {
    const env = validateEnv({
      ...baseEnv,
      SSO_ALLOWED_EMAIL_DOMAINS: 'Example.com, corp.example ,',
    });

    expect(env.SSO_ALLOWED_EMAIL_DOMAINS).toEqual([
      'example.com',
      'corp.example',
    ]);
  });

  it('refuses an insecure issuer in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, SSO_ISSUER: 'http://idp.example' }),
    ).toThrow(/SSO_ISSUER/);
  });

  it('requires an SSO client secret in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, SSO_CLIENT_SECRET: '' }),
    ).toThrow(/SSO_CLIENT_SECRET/);
  });

  it('defaults the mail transport by environment', () => {
    expect(validateEnv(baseEnv).MAIL_TRANSPORT).toBe('log');
    expect(validateEnv(productionEnv).MAIL_TRANSPORT).toBe('smtp');
  });

  it('refuses the log mail transport in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, MAIL_TRANSPORT: 'log' }),
    ).toThrow(/MAIL_TRANSPORT/);
  });

  it('requires SMTP_HOST when mail goes over SMTP', () => {
    expect(() => validateEnv({ ...baseEnv, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /SMTP_HOST/,
    );
  });

  it('defaults the payment provider by environment', () => {
    expect(validateEnv(baseEnv).PAYMENT_PROVIDER).toBe('log');
    expect(validateEnv(productionEnv).PAYMENT_PROVIDER).toBe('alipay');
  });

  it('refuses the fake payment provider in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, PAYMENT_PROVIDER: 'log' }),
    ).toThrow(/PAYMENT_PROVIDER/);
  });

  it('requires Alipay credentials when Alipay is selected', () => {
    expect(() =>
      validateEnv({ ...baseEnv, PAYMENT_PROVIDER: 'alipay' }),
    ).toThrow(/ALIPAY_APP_ID/);
  });

  it('defaults the license token settings', () => {
    const env = validateEnv(baseEnv);

    expect(env.LICENSE_JWT_ISSUER).toBe('entitlement-api');
    expect(env.LICENSE_JWT_AUDIENCE).toBe('entitlement-client');
    expect(env.LICENSE_TTL_SECONDS).toBe(43_200);
    expect(env.LICENSE_OFFLINE_TTL_DAYS).toBe(30);
  });

  it('requires a license signing key in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, LICENSE_JWT_PRIVATE_KEY: '' }),
    ).toThrow(/LICENSE_JWT_PRIVATE_KEY/);
  });
});
