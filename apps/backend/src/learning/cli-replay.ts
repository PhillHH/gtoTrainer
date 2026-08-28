import { loadEnvFile } from '../config/env.js';
import { main } from './replay-main.js';

loadEnvFile();

main().catch((error: unknown) => {
  console.error(
    '[learning:replay] Fehlgeschlagen:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
