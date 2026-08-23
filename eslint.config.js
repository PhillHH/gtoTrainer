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
      // Kanon des Nutzers - siehe Regel 6 in docs/AGENT_GUIDE.md.
      'docs/ap/**',
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
    // Konfigurationsdateien und Setup-Skripte laufen in Node und duerfen die
    // Konsole nutzen - dort ist die Ausgabe der Zweck.
    files: ['**/*.config.{js,ts}', '**/vite.config.ts', '**/vitest.config.ts', 'e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Test-Hilfsprogramme, die als eigenstaendiger Node-Prozess starten
    // (z. B. die gefaelschte Claude CLI). Flat Config bringt keine
    // Node-Globals mit; hier werden nur die tatsaechlich genutzten deklariert.
    files: ['**/test/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  prettier,
);
