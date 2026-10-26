import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const baseEnv = {
  DATABASE_URL: 'mysql://entitlement:entitlement@localhost:3306/entitlement',
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
      ...baseEnv,
      NODE_ENV: 'production',
      LOG_FORMAT: 'pretty',
      SWAGGER_ENABLED: 'true',
    });

    expect(env.LOG_FORMAT).toBe('json');
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('disables swagger in production by default', () => {
    const env = validateEnv({ ...baseEnv, NODE_ENV: 'production' });

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
        ...baseEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      }),
    ).toThrow(/CORS_ORIGINS/);
  });
});
