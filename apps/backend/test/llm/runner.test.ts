import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { isLlmError } from '../../src/llm/errors.js';
import { startRunner } from '../../src/llm/runner.js';
import { FAKE_CLI, fakeRequest, makeTempDir, testLlmConfig } from './helpers.js';

/**
 * Tests des Container-zu-Host-Wegs aus ADR-0022: Der Adapter spricht mit
 * `transport: 'socket'` einen Runner an, der die CLI seinerseits startet.
 * Beide laufen hier im selben Prozess - der Transportweg ist derselbe.
 */

let running: Server | undefined;
let cleanupDir: (() => void) | undefined;

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
  cleanupDir?.();
  cleanupDir = undefined;
});

async function startTestRunner(maxTimeoutMs = 5_000): Promise<string> {
  const temp = makeTempDir('gto-runner-');
  cleanupDir = temp.cleanup;
  const socketPath = join(temp.path, 'gto-llm.sock');

  running = await startRunner({
    socketPath,
    invocation: { claudeConfigDir: '/home/phillip/.claude-b', defaultModel: 'claude-sonnet-5' },
    spawn: { cliPath: FAKE_CLI, cwd: tmpdir() },
    maxTimeoutMs,
  });
  return socketPath;
}

describe('Host-Runner ueber Unix-Domain-Socket', () => {
  it('legt den Socket nur fuer den eigenen Benutzer lesbar an (Mode 0600)', async () => {
    const socketPath = await startTestRunner();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('liefert dasselbe Ergebnis wie der direkte Aufruf', async () => {
    const socketPath = await startTestRunner();
    const provider = new ClaudeCliProvider(
      testLlmConfig({
        transport: 'socket',
        runnerSocketPath: socketPath,
        claudeConfigDir: undefined,
      }),
    );

    const response = await provider.complete(fakeRequest('ok'));
    expect(response.text).toBe('OK');
    expect(response.meta.provider).toBe('cli');
  });

  it('reicht das Profil des Runners durch, nicht das des Clients', async () => {
    const socketPath = await startTestRunner();
    // Der Client kennt CLAUDE_CONFIG_DIR gar nicht - im Container ist das so.
    const provider = new ClaudeCliProvider(
      testLlmConfig({
        transport: 'socket',
        runnerSocketPath: socketPath,
        claudeConfigDir: undefined,
      }),
    );

    const response = await provider.complete(fakeRequest('echo-args'));
    const seen = JSON.parse(response.text) as { claudeConfigDir: string };
    expect(seen.claudeConfigDir).toBe('/home/phillip/.claude-b');
  });

  it('behaelt die Fehler-Taxonomie ueber den Socket bei', async () => {
    const socketPath = await startTestRunner();
    const provider = new ClaudeCliProvider(
      testLlmConfig({
        transport: 'socket',
        runnerSocketPath: socketPath,
        claudeConfigDir: undefined,
      }),
    );

    await expect(provider.complete(fakeRequest('ratelimit'))).rejects.toSatisfy(
      (error: unknown) => isLlmError(error) && error.kind === 'rate_limit',
    );
  });

  it('deckelt das vom Client gewuenschte Timeout auf die Obergrenze des Runners', async () => {
    const socketPath = await startTestRunner(400);
    const provider = new ClaudeCliProvider(
      testLlmConfig({
        transport: 'socket',
        runnerSocketPath: socketPath,
        claudeConfigDir: undefined,
      }),
    );

    // Der Client wuenscht 60 s, der Runner erlaubt 400 ms - und beendet selbst.
    await expect(provider.complete(fakeRequest('hang', { timeoutMs: 60_000 }))).rejects.toSatisfy(
      (error: unknown) => isLlmError(error) && error.kind === 'timeout',
    );
  });

  it('meldet einen nicht laufenden Runner als Konfigurationsproblem mit Startanweisung', async () => {
    const provider = new ClaudeCliProvider(
      testLlmConfig({
        transport: 'socket',
        runnerSocketPath: join(tmpdir(), 'gto-llm-gibt-es-nicht.sock'),
        claudeConfigDir: undefined,
      }),
    );

    await expect(provider.complete(fakeRequest('ok'))).rejects.toSatisfy(
      (error: unknown) =>
        isLlmError(error) && error.kind === 'auth' && /pnpm llm:runner/.test(error.message),
    );
  });
});
