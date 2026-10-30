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
    // Successful requests are useful while developing against the API and
    // noisy when tailing a busy server. 4xx/5xx are always logged.
    LOG_HTTP_SUCCESS: z.enum(['true', 'false']).optional(),

    BODY_LIMIT: z.string().min(1).default('1mb'),

    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
    SWAGGER_PATH: z.string().min(1).default('docs'),

    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),

    // In-process scheduler. Disabling it leaves only the admin trigger
    // (`POST /admin/jobs/:name/run`); tests disable it by default so timers
    // never race the assertions.
    SCHEDULER_ENABLED: z.enum(['true', 'false']).optional(),
    // Lets an administrator move the application clock for integration testing
    // (`POST /admin/clock`). Development only: production refuses to boot with
    // it on, so a copied `.env` cannot silently ship a time machine.
    CLOCK_CONTROL_ENABLED: z.enum(['true', 'false']).optional(),

    JOB_SETTLE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    JOB_RENEWAL_ORDERS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_600_000),
    JOB_EXPIRE_ORDERS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    JOB_SYNC_PAYMENTS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(900_000),
    JOB_NOTIFICATIONS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    /** Rows one scheduled tick may process. */
    JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
    /** How long a job lease stays valid when its holder dies mid-run. */
    JOB_LOCK_TTL_MS: z.coerce.number().int().positive().default(600_000),

    // Transactional outbound mail.
    NOTIFICATION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50),
    NOTIFICATION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    NOTIFICATION_TIME_ZONE: z.string().min(1).default('Asia/Shanghai'),
    /** Base URL of the customer portal used in message links. */
    WEB_APP_URL: z.url().default('http://localhost:5173'),

    // Session tokens (JWT, HMAC/HS256). The secret must be at least 32 chars.
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().min(1).default('entitlement-api'),
    JWT_AUDIENCE: z.string().min(1).default('entitlement-api'),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    // Single sign-on (OIDC authorization code + PKCE). This API is the relying
    // party: it never stores passwords and never touches the IdP session.
    // `SSO_ISSUER` must match the IdP's `iss` claim byte for byte.
    SSO_ISSUER: z.url().default('http://localhost:8080/realms/entitlement'),
    SSO_CLIENT_ID: z.string().min(1).default('entitlement-api'),
    /** Public (PKCE-only) clients may leave this empty; production may not. */
    SSO_CLIENT_SECRET: z.string().default(''),
    SSO_REDIRECT_URI: z
      .url()
      .default('http://localhost:3000/auth/sso/callback'),
    SSO_SCOPES: z.string().min(1).default('openid profile email'),
    /** Lifetime of the signed state that binds a browser to one login attempt. */
    SSO_STATE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600)
      .default(600),
    /** Lifetime of the one-time ticket handed to the SPA after the callback. */
    SSO_TICKET_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(300)
      .default(60),
    SSO_HTTP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(30_000)
      .default(5000),
    /** Comma separated allow-list; empty accepts every verified address. */
    SSO_ALLOWED_EMAIL_DOMAINS: z.string().default(''),

    // License tokens (EdDSA/Ed25519), independent from the HS256 session
    // tokens above. The key is a PKCS#8 PEM or its raw base64 DER. Production
    // must configure it; development and tests fall back to an ephemeral key.
    LICENSE_JWT_PRIVATE_KEY: z.string().default(''),
    LICENSE_JWT_KID: z.string().min(1).default('lic-1'),
    LICENSE_JWT_ISSUER: z.string().min(1).default('entitlement-api'),
    // The desktop SDK defaults to this audience, not the session one.
    LICENSE_JWT_AUDIENCE: z.string().min(1).default('entitlement-client'),
    LICENSE_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
    LICENSE_OFFLINE_TTL_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .max(365)
      .default(30),

    // `log` prints the message instead of sending mail: development and test
    // only.
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

    // `log` is a development/test stand-in for Alipay: it fabricates a checkout
    // URL and accepts unsigned callbacks. Production must use the real gateway.
    PAYMENT_PROVIDER: z.enum(['log', 'alipay']).optional(),
    /** How long an unpaid checkout stays valid. */
    ORDER_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
    /** How early a renewal order is created before the period ends. */
    RENEWAL_LEAD_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** A payment captured just after the checkout closed is still applied. */
    LATE_PAYMENT_GRACE_MINUTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(30),
    /** How far back the reconciliation sweep looks for missed captures. */
    PAYMENT_SYNC_WINDOW_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .max(720)
      .default(72),
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

    // The whole login flow now depends on the IdP: an unreachable issuer at
    // boot is a configuration error, and an http issuer in production would
    // expose the authorization code and the tokens to the network.
    if (production) {
      if (!env.SSO_ISSUER.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SSO_ISSUER'],
          message: 'SSO_ISSUER must use https in production',
        });
      }
      if (!env.SSO_REDIRECT_URI.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SSO_REDIRECT_URI'],
          message: 'SSO_REDIRECT_URI must use https in production',
        });
      }
      if (env.SSO_CLIENT_SECRET.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['SSO_CLIENT_SECRET'],
          message: 'SSO_CLIENT_SECRET is required in production',
        });
      }
    }

    // A message body in the log stream is customer data; production must use
    // a real transport.
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

    // Offline clients verify license tokens long after they were issued, so a
    // stable key is part of the deployment contract.
    if (production && env.LICENSE_JWT_PRIVATE_KEY.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['LICENSE_JWT_PRIVATE_KEY'],
        message: 'LICENSE_JWT_PRIVATE_KEY is required in production',
      });
    }

    // Moving the application clock is a testing tool, never a production
    // feature: it would let a compromised admin account backdate or postdate
    // every subscription.
    if (production && env.CLOCK_CONTROL_ENABLED === 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOCK_CONTROL_ENABLED'],
        message: 'CLOCK_CONTROL_ENABLED must be off in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    CORS_ORIGINS: splitCsv(env.CORS_ORIGINS),
    SSO_ALLOWED_EMAIL_DOMAINS: splitCsv(
      env.SSO_ALLOWED_EMAIL_DOMAINS.toLowerCase(),
    ),
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
    // Tests never need timers: their database is shared and assertions want
    // deterministic ordering.
    SCHEDULER_ENABLED:
      env.SCHEDULER_ENABLED === undefined
        ? env.NODE_ENV !== 'test'
        : env.SCHEDULER_ENABLED === 'true',
    // Off by default everywhere: a developer opts in per environment.
    CLOCK_CONTROL_ENABLED:
      env.CLOCK_CONTROL_ENABLED === undefined
        ? false
        : env.CLOCK_CONTROL_ENABLED === 'true',
    LOG_HTTP_SUCCESS:
      env.LOG_HTTP_SUCCESS === undefined
        ? true
        : env.LOG_HTTP_SUCCESS === 'true',
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
