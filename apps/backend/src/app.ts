import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { HEALTH_STATUS_OK } from '@gto/shared';
import type { HealthResponse } from '@gto/shared';
import authPlugin from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { LoginRateLimiter } from './auth/rate-limit.js';
import { registerChartReviewRoutes } from './chart/review-routes.js';
import { registerContentRoutes } from './content/routes.js';
import { registerConceptRoutes } from './concept/routes.js';
import type { AuthConfig } from './config/env.js';
import type { Database } from './db/client.js';
import type { JobEventBus } from './jobs/events.js';
import { registerJobRoutes } from './jobs/routes.js';
import { registerLlmLogRoutes } from './llm/log-routes.js';
import { registerLlmSettingsRoutes } from './llm/settings-routes.js';
import type { LlmProviderRegistry } from './llm/registry.js';
import type { LlmConfig } from './config/env.js';

export interface BuildAppOptions {
  readonly logger?: boolean;
  /**
   * Datenbank und Auth-Konfiguration. Fehlen sie, laeuft die App ohne
   * Auth-Routen - das nutzt nur der reine Healthcheck-Test.
   */
  readonly db?: Database;
  readonly authConfig?: AuthConfig;
  /** Nur fuer Tests: eigener Rate-Limiter, damit Zaehler isoliert bleiben. */
  readonly rateLimiter?: LoginRateLimiter;
  /**
   * Ereignisbus des Job-Workers (AP2.T2.5). Ist er gesetzt, entstehen der
   * SSE-Statuskanal und die Routen der Ansicht "letzte KI-Aufrufe".
   */
  readonly jobEvents?: JobEventBus;
  /** Nur fuer Tests: kuerzerer Keepalive-Takt im SSE-Kanal. */
  readonly sseKeepAliveMs?: number;
  /**
   * Provider-Registry und Umgebungs-Defaults (AP2.T2.6). Sind sie gesetzt,
   * entstehen die Einstellungs-Routen samt Ping-Test.
   */
  readonly providers?: LlmProviderRegistry;
  readonly llmConfig?: LlmConfig;
  /** Nur fuer Tests: kuerzere Sperrzeit zwischen zwei Ping-Tests. */
  readonly pingCooldownMs?: number;
  /**
   * Abweichendes Quellverzeichnis der Buchbilder (AP3.T3.4). Nur fuer Tests -
   * im Betrieb gilt `BOOK_SOURCE_DIR` bzw. `data/book-source/`.
   */
  readonly bookSourceDir?: string;
}

/**
 * Baut die Fastify-Instanz auf, ohne sie zu starten.
 *
 * Getrennt von server.ts, damit Tests die App per `app.inject()` ansprechen
 * koennen, ohne einen echten Port zu belegen.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  // Liveness-Probe. BEWUSST OEFFENTLICH - sie wird ab T1.5 vom Host-Nginx und
  // vom Container-Healthcheck ohne Session aufgerufen.
  app.get('/healthz', async (): Promise<HealthResponse> => {
    return { status: HEALTH_STATUS_OK };
  });

  if (options.db && options.authConfig) {
    await app.register(authPlugin, { db: options.db, config: options.authConfig });
    registerAuthRoutes(app, {
      db: options.db,
      config: options.authConfig,
      ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    });

    registerLlmLogRoutes(app, { db: options.db });

    // Review-Ansicht des Konzept-Graphen (AP3.T3.2). Nicht die Content-API -
    // die entsteht in T3.5 unter /api/content.
    registerConceptRoutes(app, { db: options.db });

    // Review-Ansicht der Chart-Validierung (AP3.T3.4). Ebenfalls nicht die
    // Content-API - die entsteht in T3.5 unter /api/content.
    registerChartReviewRoutes(app, {
      db: options.db,
      ...(options.bookSourceDir === undefined ? {} : { sourceDir: options.bookSourceDir }),
    });

    // Content-API (AP3.T3.5): der Lesezugriff, ueber den AP5 bis AP8 gehen.
    // Nur lesend, auth-geschuetzt, und ohne includeUnapproved ausschliesslich
    // freigegebene Charts.
    registerContentRoutes(app, {
      db: options.db,
      ...(options.bookSourceDir === undefined ? {} : { sourceDir: options.bookSourceDir }),
    });

    if (options.providers && options.llmConfig) {
      registerLlmSettingsRoutes(app, {
        db: options.db,
        providers: options.providers,
        fallback: options.llmConfig,
        ...(options.pingCooldownMs === undefined ? {} : { pingCooldownMs: options.pingCooldownMs }),
      });
    }

    if (options.jobEvents) {
      registerJobRoutes(app, {
        db: options.db,
        events: options.jobEvents,
        ...(options.sseKeepAliveMs === undefined ? {} : { keepAliveMs: options.sseKeepAliveMs }),
      });
    }
  }

  return app;
}
