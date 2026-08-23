/**
 * LLM-Gateway des Backends.
 *
 * Nach aussen fuehrt genau ein Weg zu einem Modell: die
 * {@link LlmProviderRegistry}. Sie waehlt anhand der Konfiguration zwischen
 * Adapter A (Claude CLI, Profil B) und Adapter B (Anthropic Messages API).
 * Fachliche Module halten sich an `LLMProvider` aus `@gto/shared` und kennen
 * weder Prozessaufrufe noch HTTP (siehe docs/INTERFACES.md, Abschnitt 8).
 */
export { LlmProviderRegistry, createDbConfigSource, LLM_PROVIDER_CONFIG_KEY } from './registry.js';
export type { ProviderConfigSource, ProviderFactory, RegistryOptions } from './registry.js';

export { LlmError, isLlmError } from './errors.js';
export { GuardedProvider } from './base-provider.js';
export type { ProviderLimits } from './base-provider.js';

// Adapter und Runner: fuer Registry, Paritaetstests und den Host-Runner.
// Fachliche Module nutzen sie NICHT direkt - der Weg ist die Registry.
export { ClaudeCliProvider, createClaudeCliProvider } from './cli-provider.js';
export { AnthropicApiProvider, createAnthropicApiProvider } from './api-provider.js';
export { Semaphore, withRetry } from './concurrency.js';
export type { RetryPolicy } from './concurrency.js';
export { startRunner, callRunner, RUNNER_PROTOCOL_VERSION } from './runner.js';
export type { RunnerEvent, RunnerOptions } from './runner.js';
