import { loadEnvFile } from '../config/env.js';
import { main } from './reset.js';

// .env laden, BEVOR die Schutzbedingungen geprueft werden - DB_RESET_CONFIRM
// darf auch aus der .env kommen.
loadEnvFile();

main().catch((error: unknown) => {
  console.error('[reset] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
