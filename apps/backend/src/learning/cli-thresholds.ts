import { loadEnvFile } from '../config/env.js';
import { main } from './thresholds-main.js';

loadEnvFile();

main().catch((error: unknown) => {
  console.error(
    '[learning:thresholds] Fehlgeschlagen:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
