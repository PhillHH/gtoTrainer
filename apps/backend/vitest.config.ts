import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Legt die Testdatenbank an und migriert sie, bevor Tests laufen.
    globalSetup: ['./test/db/global-setup.ts'],
    // Die DB-Integrationstests teilen sich eine Datenbank - Dateien laufen
    // deshalb nacheinander statt parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    alias: {
      // Tests laufen gegen die Quellen von @gto/shared, damit `pnpm test`
      // unabhaengig von einem vorherigen `pnpm build` gruen ist.
      '@gto/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
