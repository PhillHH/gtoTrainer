import type { LLMProvider, LlmRequest, LlmResponse } from '@gto/shared';
import { ConfigError, loadLlmConfig } from '../config/env.js';
import type { LlmConfig } from '../config/env.js';
import { Semaphore, withRetry } from './concurrency.js';
import { LlmError, isLlmError } from './errors.js';
import { interpretCliResult } from './interpret.js';
import { buildInvocation } from './invocation.js';
import { callRunner } from './runner.js';
import { runCli } from './spawn.js';
import type { CliResult } from './spawn.js';

/**
 * Adapter A: Claude Code CLI gegen **Profil B**.
 *
 * Implementiert `LLMProvider` aus `@gto/shared` - den einzigen erlaubten
 * KI-Zugang. Der Adapter kennt zwei Transportwege, die sich ausschliesslich
 * ueber die Konfiguration unterscheiden (ADR-0022):
 *
 * - `direct` - dieser Prozess startet die CLI selbst (lokal, und im Runner),
 * - `socket` - dieser Prozess reicht die Anfrage an den Host-Runner weiter
 *   (Container).
 *
 * Nebenlaeufigkeit und Retry liegen in beiden Faellen hier, damit der Host
 * nicht ueber den Umweg vieler Verbindungen doch ueberlastet wird.
 */
export class ClaudeCliProvider implements LLMProvider {
  readonly id = 'cli' as const;
  readonly #config: LlmConfig;
  readonly #semaphore: Semaphore;

  constructor(config: LlmConfig) {
    this.#config = config;
    this.#semaphore = new Semaphore(config.maxConcurrency);
  }

  /** Nur fuer Diagnose und Tests: aktuelle Auslastung der Semaphore. */
  get inFlight(): number {
    return this.#semaphore.inFlight;
  }

  async complete<TJson = unknown>(request: LlmRequest): Promise<LlmResponse<TJson>> {
    assertRequest(request);
    const timeoutMs = request.timeoutMs ?? this.#config.timeoutMs;

    const response = await withRetry(
      () => this.#semaphore.run(() => this.#attempt(request, timeoutMs)),
      {
        maxAttempts: this.#config.maxAttempts,
        baseDelayMs: this.#config.retryBaseDelayMs,
        maxDelayMs: this.#config.retryMaxDelayMs,
        totalBudgetMs: this.#config.retryTotalBudgetMs,
      },
      {
        // Einzige Quelle der Wahrheit ist die Taxonomie aus T2.1.
        isRetryable: (error) => isLlmError(error) && error.retryable,
        retryAfterMs: (error) => (isLlmError(error) ? error.retryAfterMs : undefined),
      },
    );

    return response as LlmResponse<TJson>;
  }

  /** Ein einzelner Versuch: aufrufen, auswerten, Dauer messen. */
  async #attempt(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const startedAt = Date.now();
    const result = await this.#invoke(request, timeoutMs);
    return interpretCliResult(request, result, {
      model: this.#config.model,
      durationMs: Date.now() - startedAt,
    });
  }

  #invoke(request: LlmRequest, timeoutMs: number): Promise<CliResult> {
    if (this.#config.transport === 'socket') {
      // Der Pfad ist bei transport==='socket' durch loadLlmConfig garantiert.
      return callRunner(this.#config.runnerSocketPath as string, request, timeoutMs);
    }
    const invocation = buildInvocation(request, {
      claudeConfigDir: this.#config.claudeConfigDir as string,
      defaultModel: this.#config.model,
    });
    return runCli(invocation, {
      cliPath: this.#config.cliPath,
      cwd: this.#config.cliCwd,
      timeoutMs,
    });
  }
}

/**
 * Baut den Adapter aus der Umgebung.
 *
 * Wirft `ConfigError`, wenn `CLAUDE_CONFIG_DIR` fehlt und dieser Prozess die
 * CLI selbst starten wuerde - **ohne** Rueckfall auf ein Default-Profil.
 */
export function createClaudeCliProvider(config: LlmConfig = loadLlmConfig()): ClaudeCliProvider {
  if (config.transport === 'direct' && config.claudeConfigDir === undefined) {
    throw new ConfigError(
      'Pflicht-Umgebungsvariable CLAUDE_CONFIG_DIR fehlt oder ist leer. ' +
        'Der Claude-CLI-Adapter laeuft ausschliesslich gegen Profil B.',
    );
  }
  return new ClaudeCliProvider(config);
}

/** Frueher Abbruch bei offensichtlich unbrauchbaren Anfragen. */
function assertRequest(request: LlmRequest): void {
  if (request.messages.length === 0) {
    throw new LlmError({
      kind: 'invalid',
      provider: 'cli',
      message: 'Die Anfrage enthaelt keine Nachricht.',
    });
  }
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
    throw new LlmError({
      kind: 'invalid',
      provider: 'cli',
      message: `maxTokens muss eine positive Ganzzahl sein, ist: ${String(request.maxTokens)}.`,
    });
  }
}
