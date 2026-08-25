import { loadLlmConfig, loadWorkerConfig } from '../config/env.js';
import type { LlmConfig, WorkerConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { createDbCallLogSink } from '../llm/call-log.js';
import { LlmProviderRegistry } from '../llm/registry.js';
import { createSettingsReader } from '../llm/settings.js';
import { TemplateRegistry } from '../prompts/registry.js';
import { JobEventBus } from './events.js';
import { createChartDigitizeJob } from './handlers/chart-digitize.js';
import { createChartLegendJob } from './handlers/chart-legend.js';
import { createChartRecheckJob } from './handlers/chart-recheck.js';
import { createConceptExtractJob } from './handlers/concept-extract.js';
import { createLlmCompleteJob } from './handlers/llm-complete.js';
import { JobHandlerRegistry } from './types.js';
import { JobWorker } from './worker.js';

/**
 * Baut die Laufzeit des LLM-Gateways an **einer** Stelle zusammen (AP2.T2.5):
 * Template-Registry, Provider-Registry samt Aufruf-Protokoll, Ereignisbus,
 * Handler-Registry und Worker.
 *
 * Der Zusammenbau liegt bewusst hier und nicht in `server.ts`: So koennen
 * Tests und Skripte (`pnpm jobs:enqueue`) dieselbe Verdrahtung nutzen, ohne
 * einen HTTP-Server zu starten.
 */

export interface LlmRuntime {
  readonly templates: TemplateRegistry;
  readonly llmConfig: LlmConfig;
  readonly providers: LlmProviderRegistry;
  readonly handlers: JobHandlerRegistry;
  readonly events: JobEventBus;
  readonly worker: JobWorker;
  readonly workerConfig: WorkerConfig;
}

export interface CreateRuntimeOptions {
  readonly db: Database;
  readonly llmConfig?: LlmConfig;
  readonly workerConfig?: WorkerConfig;
  readonly log?: (message: string) => void;
}

export function createLlmRuntime(options: CreateRuntimeOptions): LlmRuntime {
  const llmConfig = options.llmConfig ?? loadLlmConfig();
  const workerConfig = options.workerConfig ?? loadWorkerConfig();
  const log = options.log ?? (() => undefined);

  const templates = TemplateRegistry.load();
  const events = new JobEventBus();

  // Das Aufruf-Protokoll haengt an der Registry, nicht am Aufrufer: Damit wird
  // **jeder** Provider-Aufruf protokolliert, auch der aus einem kuenftigen AP.
  // Die Laufzeit-Einstellungen aus der `config`-Tabelle bestimmen Provider,
  // Modell und Aufrufparameter (T2.6). Sie werden bei jedem Aufruf gelesen -
  // eine Umschaltung wirkt damit ohne Neustart.
  const settings = createSettingsReader(options.db, llmConfig);

  const providers = new LlmProviderRegistry({
    config: llmConfig,
    settings,
    callLog: {
      sink: createDbCallLogSink(options.db),
      maxChars: workerConfig.logMaxChars,
      // Ein Fehler beim Protokollieren darf den Aufruf nie scheitern lassen.
      onLogFailure: (error) =>
        log(
          `Aufruf-Protokoll konnte nicht geschrieben werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    },
  });

  const handlers = new JobHandlerRegistry()
    .register(
      createLlmCompleteJob({
        providers,
        templates,
        defaultModel: llmConfig.model,
        // Grosszuegig: Ein abgeschnittener Prompt kostet mehr als ein paar Tokens.
        defaultMaxTokens: 4096,
        // Modell und Timeout kommen bevorzugt aus den Einstellungen.
        settings,
      }),
    )
    // Konzept-Taxonomie (AP3.T3.2): ein Job je Kapitelteil.
    .register(
      createConceptExtractJob({
        providers,
        templates,
        defaultModel: llmConfig.model,
        settings,
      }),
    )
    // Chart-Digitalisierung (AP3.T3.3): ein Job je Chart-Bild.
    .register(
      createChartDigitizeJob({
        providers,
        templates,
        defaultModel: llmConfig.model,
        settings,
      }),
    )
    // Gezielter Zweitdurchlauf beanstandeter Charts (AP3.T3.4).
    .register(
      createChartLegendJob({
        providers,
        templates,
        defaultModel: llmConfig.model,
        settings,
      }),
    )
    .register(
      createChartRecheckJob({
        providers,
        templates,
        defaultModel: llmConfig.model,
        settings,
      }),
    );

  const worker = new JobWorker({
    db: options.db,
    handlers,
    events,
    pollIntervalMs: workerConfig.pollIntervalMs,
    staleAfterMs: workerConfig.staleAfterMs,
    retryBaseDelayMs: llmConfig.retryBaseDelayMs,
    retryMaxDelayMs: llmConfig.retryMaxDelayMs,
    log,
  });

  return { templates, providers, handlers, events, worker, workerConfig, llmConfig };
}
