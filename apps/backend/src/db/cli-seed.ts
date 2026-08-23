import { main } from './seed.js';

main().catch((error: unknown) => {
  console.error('[seed] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
