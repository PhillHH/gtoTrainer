/**
 * LLM-Gateway des Backends.
 *
 * Nach aussen gibt es genau einen Einstieg: `createClaudeCliProvider()` liefert
 * eine Implementierung von `LLMProvider` aus `@gto/shared`. Fachliche Module
 * halten sich an dieses Interface und kennen weder Prozessaufrufe noch den
 * Transportweg (siehe docs/INTERFACES.md, Abschnitt 8).
 */
export { ClaudeCliProvider, createClaudeCliProvider } from './cli-provider.js';
export { LlmError, isLlmError } from './errors.js';
export { Semaphore, withRetry } from './concurrency.js';
export type { RetryPolicy } from './concurrency.js';
export { startRunner, callRunner, RUNNER_PROTOCOL_VERSION } from './runner.js';
export type { RunnerEvent, RunnerOptions } from './runner.js';
