import { main } from './set-password.js';

main().catch((error: unknown) => {
  console.error('[auth] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
