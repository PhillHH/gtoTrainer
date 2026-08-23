import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDb, registerShutdownHandlers } from './db/client.js';
import { createLlmRuntime } from './jobs/runtime.js';

const config = loadConfig();
const handle = createDb(config.databaseUrl);

// Template-Registry, Provider-Registry mit Aufruf-Protokoll, Ereignisbus und
// Worker - alles an einer Stelle verdrahtet (AP2.T2.5).
const runtime = createLlmRuntime({
  db: handle.db,
  log: (message) => app.log.info(message),
});

const app = await buildApp({
  logger: true,
  db: handle.db,
  authConfig: config.auth,
  jobEvents: runtime.events,
  providers: runtime.providers,
  llmConfig: runtime.llmConfig,
});

// Der Worker laeuft im selben Prozess wie der HTTP-Server (ADR-0026).
if (runtime.workerConfig.enabled) {
  runtime.worker.start();
} else {
  app.log.warn('Job-Worker ist per WORKER_ENABLED=false abgeschaltet.');
}

// Beim Herunterfahren erst den Worker anhalten, dann HTTP, dann den DB-Pool.
registerShutdownHandlers(handle, async () => {
  await runtime.worker.stop();
  await app.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await runtime.worker.stop();
  await handle.close();
  process.exit(1);
}
