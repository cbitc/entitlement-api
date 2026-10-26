import { z } from 'zod';

/**
 * Splits a comma separated environment variable into a trimmed, non-empty
 * list. Values are never URL-parsed here; validation of their shape belongs to
 * the consumer.
 */
const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/**
 * Source of truth for every environment variable the process accepts.
 *
 * The object is validated once at boot: an invalid value stops the process
 * instead of failing later on a request. Defaults are chosen so a fresh clone
 * runs against the compose MySQL instance without extra tuning.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    APP_NAME: z.string().min(1).default('entitlement-api'),
    APP_VERSION: z.string().min(1).default('0.0.0'),

    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('mysql://'),
        'DATABASE_URL must be a MySQL connection string (mysql://...)',
      ),

    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).optional(),

    BODY_LIMIT: z.string().min(1).default('1mb'),

    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
    SWAGGER_PATH: z.string().min(1).default('docs'),

    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    const origins = splitCsv(env.CORS_ORIGINS);
    if (origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must list at least one origin in production',
      });
    }
    if (origins.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not contain the wildcard origin',
      });
    }
  })
  .transform((env) => ({
    ...env,
    CORS_ORIGINS: splitCsv(env.CORS_ORIGINS),
    // Humans read pretty logs; log shippers need JSON. Production never gets
    // colours, regardless of what the environment claims.
    LOG_FORMAT:
      env.NODE_ENV === 'production'
        ? ('json' as const)
        : (env.LOG_FORMAT ?? 'pretty'),
    // Exposing the API documentation is a development convenience.
    SWAGGER_ENABLED:
      env.SWAGGER_ENABLED === undefined
        ? env.NODE_ENV !== 'production'
        : env.SWAGGER_ENABLED === 'true',
  }));

export type Env = z.output<typeof envSchema>;

/**
 * `ConfigModule` validator. Throws with every offending key so a bad deploy
 * fails with an actionable message rather than a stack trace from deep inside
 * the app.
 */
export const validateEnv = (raw: Record<string, unknown>): Env => {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');

  throw new Error(`Invalid environment configuration: ${details}`);
};
