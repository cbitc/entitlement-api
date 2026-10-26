import 'reflect-metadata';

// Tests must not depend on a developer's local `.env`. These values are only
// applied when the variable is absent, so CI can still override them.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??=
  'mysql://entitlement:entitlement@localhost:3306/entitlement_test';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-with-32-characters';
process.env.MAIL_TRANSPORT ??= 'log';
process.env.LOG_LEVEL ??= 'silent';
