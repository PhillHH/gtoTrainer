// Flache ESLint-Konfiguration (Flat Config) fuer das gesamte Monorepo.
// Prettier wird ueber eslint-config-prettier eingebunden: ESLint kuemmert sich um
// Code-Qualitaet, Prettier allein um Formatierung -> konfliktfrei.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'data/book-source/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Konfigurationsdateien laufen in Node und duerfen die Konsole nutzen.
    files: ['**/*.config.{js,ts}', '**/vite.config.ts', '**/vitest.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
