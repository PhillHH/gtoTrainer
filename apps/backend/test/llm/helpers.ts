import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmRequest } from '@gto/shared';
import type { LlmConfig } from '../../src/config/env.js';

/** Pfad der gefaelschten CLI - ausfuehrbar, mit Shebang. */
export const FAKE_CLI = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

/**
 * Konfiguration fuer die Adapter-Tests. Retry ist standardmaessig aus
 * (`maxAttempts: 1`), damit ein Test, der einen Fehler erwartet, nicht wartet.
 */
export function testLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    transport: 'direct',
    claudeConfigDir: '/home/phillip/.claude-b',
    cliPath: FAKE_CLI,
    cliCwd: tmpdir(),
    runnerSocketPath: undefined,
    model: 'claude-sonnet-5',
    timeoutMs: 5_000,
    maxConcurrency: 4,
    maxAttempts: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    retryTotalBudgetMs: 10_000,
    ...overrides,
  };
}

/**
 * Baut einen Request, dessen Prompt die gefaelschte CLI steuert. Die Direktive
 * reist ueber stdin - denselben Weg wie ein echter Prompt.
 */
export function fakeRequest(directive: string, overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'Antworte knapp.',
    messages: [{ role: 'user', content: [{ type: 'text', text: `FAKE:${directive}` }] }],
    model: 'claude-sonnet-5',
    maxTokens: 64,
    ...overrides,
  };
}

/** Wegwerf-Verzeichnis, das der Test am Ende wieder abraeumt. */
export function makeTempDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Wertet eine Trace-Datei der gefaelschten CLI aus: `S` = Prozess gestartet,
 * `E` = Prozess fertig. Liefert die hoechste gleichzeitig laufende Anzahl.
 */
export function maxConcurrentFromTrace(tracePath: string): number {
  const marks = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
  let running = 0;
  let peak = 0;
  for (const mark of marks) {
    if (mark === 'S') {
      running += 1;
      peak = Math.max(peak, running);
    } else {
      running -= 1;
    }
  }
  return peak;
}
