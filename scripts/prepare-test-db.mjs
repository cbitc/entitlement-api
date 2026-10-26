#!/usr/bin/env node
/**
 * Applies the Prisma migrations to the e2e database.
 *
 * The application validates `DATABASE_URL`; the test suite connects to
 * `DATABASE_URL_TEST` so running the tests can never touch development data.
 * A freshly created docker volume has no schema, so run this before `test:e2e`.
 */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(root, '.env') });

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error(
    'DATABASE_URL_TEST is not set. Copy .env.example to .env and fill it in.',
  );
  process.exit(1);
}

execSync('corepack pnpm prisma migrate deploy', {
  cwd: root,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
});
