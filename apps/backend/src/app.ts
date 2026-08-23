import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { HEALTH_STATUS_OK } from '@gto/shared';
import type { HealthResponse } from '@gto/shared';

/**
 * Baut die Fastify-Instanz auf, ohne sie zu starten.
 *
 * Getrennt von server.ts, damit Tests die App per `app.inject()` ansprechen
 * koennen, ohne einen echten Port zu belegen.
 */
export function buildApp(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Liveness-Probe. Der produktive Betrieb hinter Nginx folgt in AP1.T1.5;
  // hier existiert zunaechst nur die Route selbst.
  app.get('/healthz', async (): Promise<HealthResponse> => {
    return { status: HEALTH_STATUS_OK };
  });

  return app;
}
