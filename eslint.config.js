import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'safari/', 'artifacts/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', 'extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, chrome: 'readonly' }
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
