import { main } from './migrate.js';

main().catch((error: unknown) => {
  console.error('[migrate] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
