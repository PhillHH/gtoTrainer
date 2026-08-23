import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

/**
 * Testkonfiguration, getrennt von vite.config.ts - so bleibt die Build-Konfig
 * frei von Test-Typen (und `tsc --noEmit` frei von Vitest-Abhaengigkeiten).
 * Gleiche Aufteilung wie in apps/backend und packages/shared.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
      css: false,
      alias: {
        // Gegen die Quellen von @gto/shared testen, damit `pnpm test`
        // unabhaengig von einem vorherigen `pnpm build` gruen ist -
        // gleiche Loesung wie in apps/backend.
        '@gto/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },
  }),
);
