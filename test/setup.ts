import 'reflect-metadata';

// Tests must not depend on a developer's local `.env`. These values are only
// applied when the variable is absent, so CI can still override them.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??=
  'mysql://entitlement:entitlement@localhost:3306/entitlement_test';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-with-32-characters';
process.env.MAIL_TRANSPORT ??= 'log';
process.env.LOG_LEVEL ??= 'silent';
// Licensing defaults must be deterministic even when a developer's .env
// carries sandbox/production values.
process.env.LICENSE_JWT_ISSUER ??= 'entitlement-api';
process.env.LICENSE_JWT_AUDIENCE ??= 'entitlement-client';
process.env.LICENSE_TTL_SECONDS ??= '3600';
process.env.LICENSE_OFFLINE_TTL_DAYS ??= '30';
// The local .env points at the Alipay sandbox; e2e must stay deterministic.
process.env.PAYMENT_PROVIDER ??= 'log';
// Timers must never race the assertions; tests call the job runner directly.
process.env.SCHEDULER_ENABLED ??= 'false';
process.env.NOTIFICATION_TIME_ZONE ??= 'Asia/Shanghai';
process.env.WEB_APP_URL ??= 'http://localhost:5173';
