import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'artifacts/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: { 'no-console': ['warn', { allow: ['info', 'warn', 'error'] }] }
  },
  {
    // The Walmart product adapter is intentionally kept close to its proven,
    // standalone implementation while the shared runtime evolves around it.
    files: ['src/retailers/walmart/content.js', 'src/retailers/walmart/api-capture-main.js'],
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-useless-escape': 'off'
    }
  }
];
