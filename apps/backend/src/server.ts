import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDb, registerShutdownHandlers } from './db/client.js';

const config = loadConfig();
const handle = createDb(config.databaseUrl);

const app = await buildApp({ logger: true, db: handle.db, authConfig: config.auth });

// Beim Herunterfahren erst den HTTP-Server schliessen, dann den DB-Pool.
registerShutdownHandlers(handle, async () => {
  await app.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await handle.close();
  process.exit(1);
}
