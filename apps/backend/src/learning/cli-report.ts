import { loadEnvFile } from '../config/env.js';
import { main } from './report-main.js';

loadEnvFile();

main().catch((error: unknown) => {
  console.error(
    '[learning:report] Fehlgeschlagen:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
