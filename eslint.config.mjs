import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Business time must come from the injected Clock so a test can place the
    // application at any instant. The files below read the wall clock on
    // purpose: the system clock itself, provider protocol timestamps, the
    // database-clock lease comparison, and purely cosmetic response fields.
    files: ['src/**/*.ts'],
    ignores: [
      'src/**/*.spec.ts',
      'src/infra/clock/**',
      'src/infra/payments/alipay.gateway.ts',
      'src/scheduling/job-lock.service.ts',
      'src/health/health.controller.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Inject Clock and use clock.now() instead of new Date(). If this is real protocol time, add the file to the allowlist in eslint.config.mjs.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Inject Clock and use clock.now().getTime() instead of Date.now().',
        },
      ],
    },
  },
  prettier,
);
