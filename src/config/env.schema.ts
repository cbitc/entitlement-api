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

    // Session tokens (JWT, HMAC/HS256). The secret must be at least 32 chars.
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().min(1).default('entitlement-api'),
    JWT_AUDIENCE: z.string().min(1).default('entitlement-api'),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    // Key for the verification-code HMAC. Falls back to JWT_SECRET.
    VERIFICATION_CODE_SECRET: z.string().min(32).optional(),

    // `log` prints the code instead of sending mail: development and test only.
    MAIL_TRANSPORT: z.enum(['log', 'smtp']).optional(),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z
      .string()
      .min(1)
      .default('Entitlement Portal <no-reply@example.com>'),

    // `log` fabricates a checkout URL and accepts unsigned callbacks: dev and
    // test only. Production must talk to a real provider.
    PAYMENT_PROVIDER: z.enum(['log', 'alipay']).optional(),
    /** How long an unpaid checkout stays valid. */
    ORDER_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
    /** How early a renewal order is created before the period ends. */
    RENEWAL_LEAD_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    ALIPAY_APP_ID: z.string().default(''),
    /** PKCS#8 private key, raw base64 or full PEM. */
    ALIPAY_PRIVATE_KEY: z.string().default(''),
    /** Alipay public key used to verify callbacks, raw base64 or full PEM. */
    ALIPAY_PUBLIC_KEY: z.string().default(''),
    ALIPAY_GATEWAY_URL: z
      .string()
      .url()
      .default('https://openapi.alipay.com/gateway.do'),
    PAYMENT_NOTIFY_URL: z
      .string()
      .url()
      .default('http://localhost:3000/payments/alipay/notify'),
    PAYMENT_RETURN_URL: z
      .string()
      .url()
      .default('http://localhost:5173/checkout/return'),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    const origins = splitCsv(env.CORS_ORIGINS);

    if (production && origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must list at least one origin in production',
      });
    }
    if (production && origins.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not contain the wildcard origin',
      });
    }

    // A login code in the log stream would be a credential leak.
    const transport = env.MAIL_TRANSPORT ?? (production ? 'smtp' : 'log');
    if (production && transport !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'MAIL_TRANSPORT must be "smtp" in production',
      });
    }
    if (transport === 'smtp' && env.SMTP_HOST.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when MAIL_TRANSPORT is "smtp"',
      });
    }

    // A fabricated checkout is unacceptable once real money is involved.
    const payments = env.PAYMENT_PROVIDER ?? (production ? 'alipay' : 'log');
    if (production && payments !== 'alipay') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'PAYMENT_PROVIDER must be "alipay" in production',
      });
    }
    if (payments === 'alipay') {
      for (const key of [
        'ALIPAY_APP_ID',
        'ALIPAY_PRIVATE_KEY',
        'ALIPAY_PUBLIC_KEY',
      ] as const) {
        if (env[key].length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PAYMENT_PROVIDER is "alipay"`,
          });
        }
      }
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
    // Codes go to the log only outside production; production must use SMTP.
    MAIL_TRANSPORT:
      env.MAIL_TRANSPORT ??
      (env.NODE_ENV === 'production' ? ('smtp' as const) : ('log' as const)),
    SMTP_SECURE: env.SMTP_SECURE === 'true',
    // Outside production the fake provider keeps the checkout flow runnable.
    PAYMENT_PROVIDER:
      env.PAYMENT_PROVIDER ??
      (env.NODE_ENV === 'production' ? ('alipay' as const) : ('log' as const)),
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
