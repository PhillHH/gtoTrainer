import { loadEnvFile } from '../config/env.js';
import { main } from './reset.js';

// .env laden, BEVOR die Schutzbedingung geprueft wird - LEARNING_RESET_CONFIRM
// darf auch aus der .env kommen.
loadEnvFile();

main().catch((error: unknown) => {
  console.error('[learning:reset] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
