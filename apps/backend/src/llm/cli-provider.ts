import type { LlmRequest, LlmResponse } from '@gto/shared';
import { ConfigError, loadLlmConfig } from '../config/env.js';
import type { LlmConfig } from '../config/env.js';
import { GuardedProvider } from './base-provider.js';
import { interpretCliResult } from './interpret.js';
import { buildInvocation } from './invocation.js';
import { callRunner } from './runner.js';
import { runCli } from './spawn.js';
import type { CliResult } from './spawn.js';

/**
 * Adapter A: Claude Code CLI gegen **Profil B**.
 *
 * Implementiert `LLMProvider` aus `@gto/shared` - den einzigen erlaubten
 * KI-Zugang. Nebenlaeufigkeit, Retry und die Vorpruefung der Anfrage kommen
 * aus {@link GuardedProvider} und sind mit dem API-Adapter identisch.
 *
 * Der Adapter kennt zwei Transportwege, die sich ausschliesslich ueber die
 * Konfiguration unterscheiden (ADR-0022):
 *
 * - `direct` - dieser Prozess startet die CLI selbst (lokal, und im Runner),
 * - `socket` - dieser Prozess reicht die Anfrage an den Host-Runner weiter
 *   (Container).
 */
export class ClaudeCliProvider extends GuardedProvider {
  readonly id = 'cli' as const;
  readonly #config: LlmConfig;

  constructor(config: LlmConfig) {
    super(config);
    this.#config = config;
  }

  /** Ein einzelner Versuch: aufrufen, auswerten, Dauer messen. */
  protected async attempt(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
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
