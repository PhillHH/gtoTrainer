import { loadEnvFile } from '../config/env.js';
import { main } from './level-main.js';

loadEnvFile();

main().catch((error: unknown) => {
  console.error('[learning:level] Fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
