import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Typebenen-Tests (*.test-d.ts) laufen mit `vitest run` mit. Ohne das
    // wuerde `tsc -b` sie nie sehen: das Build-tsconfig umfasst nur src/.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
