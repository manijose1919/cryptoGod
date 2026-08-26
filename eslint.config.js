import js from '@eslint/js';
import globals from 'globals';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      // Registered because hooks/*.ts already carry
      // `// eslint-disable-next-line react-hooks/exhaustive-deps` comments. Without
      // the plugin those comments reference an unknown rule, which ESLint reports as
      // an error — the config was failing on its own source's disable directives.
      'react-hooks': reactHooks,
    },
    rules: {
      // tsc owns undefined-identifier and redeclare checking for TypeScript, and does
      // it correctly — `npx tsc --noEmit` runs in CI and is green. The core ESLint
      // rules only see values, so they misread type-only references: `RequestInit` in
      // a type position reads as undefined, and the const-object + companion-type
      // pattern (see core/mlProfitLabeler.ts) reads as a redeclare. Both are legal TS.
      // This is why the block below no longer hand-maintains a `globals` list — that
      // list existed solely to feed no-undef, and was permanently incomplete.
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'smart'],
      'no-throw-literal': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // .mjs/.cjs matter: scripts/ is all .mjs. Without them here those files fall
    // through to js.configs.recommended with no globals at all, and every console
    // and process reference reports as no-undef.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Every .js file outside the ignores is backend: services/, routes/,
      // scripts/, middleware/, tests/.
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off', // Backend files use console for logging
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'data/**', '*.config.js', '*.config.ts', 'vitest.config.ts'],
  },
];
