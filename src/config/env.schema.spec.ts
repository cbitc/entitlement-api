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

  it('defaults the mail transport by environment', () => {
    expect(validateEnv(baseEnv).MAIL_TRANSPORT).toBe('log');
    expect(validateEnv(productionEnv).MAIL_TRANSPORT).toBe('smtp');
  });

  it('refuses to print login codes in production', () => {
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
});
