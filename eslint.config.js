import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const ignores = ['**/dist/**', '**/node_modules/**', 'data/**', 'playwright-report/**', 'test-results/**'];

const noLossyMoney = [
  { selector: "CallExpression[callee.name='parseInt']", message: 'Parse amounts with money.ts.' },
  { selector: "CallExpression[callee.name='parseFloat']", message: 'Parse amounts with money.ts.' },
];

const noAsyncTransaction = [
  {
    selector: "CallExpression[callee.property.name='transaction'] > :function[async=true]",
    message: 'better-sqlite3 transactions must be synchronous.',
  },
];

export default tseslint.config(
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': ['error', ...noLossyMoney, ...noAsyncTransaction],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/protocol/src/**'],
    ignores: ['packages/protocol/src/**/*.test.ts', 'packages/protocol/src/testing/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'better-sqlite3', 'fastify', '@fastify/*'] }],
    },
  },
  {
    files: ['apps/web/src/**'],
    ignores: ['apps/web/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'better-sqlite3', 'fastify'] }],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Round state lives in IndexedDB.' },
        { name: 'sessionStorage', message: 'Round state lives in IndexedDB.' },
      ],
    },
  },
);
