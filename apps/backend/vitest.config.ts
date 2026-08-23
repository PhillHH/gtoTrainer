import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    alias: {
      // Tests laufen gegen die Quellen von @gto/shared, damit `pnpm test`
      // unabhaengig von einem vorherigen `pnpm build` gruen ist.
      '@gto/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
