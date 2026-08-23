import { ConfigError, loadLlmConfig } from '../config/env.js';
import { startRunner } from './runner.js';

/**
 * Einstiegspunkt des Host-seitigen CLI-Runners (ADR-0022).
 *
 * Laeuft **auf dem Host** als Benutzer `phillip`, nicht im Container. Start:
 *
 *   pnpm llm:runner
 *
 * Der Runner ist bewusst der einzige Ort, der Profil B kennt. Er erzwingt
 * `LLM_TRANSPORT=direct` fuer sich selbst - ein Runner, der einen Runner ruft,
 * waere eine Schleife.
 */
async function main(): Promise<void> {
  process.env['LLM_TRANSPORT'] = 'direct';
  const config = loadLlmConfig();

  if (config.runnerSocketPath === undefined) {
    throw new ConfigError(
      'Der CLI-Runner braucht LLM_RUNNER_SOCKET_DIR oder LLM_RUNNER_SOCKET_PATH ' +
        '(siehe .env.example, Abschnitt LLM-Gateway).',
    );
  }
  // Wird durch LLM_TRANSPORT=direct oben garantiert.
  const claudeConfigDir = config.claudeConfigDir as string;

  const server = await startRunner({
    socketPath: config.runnerSocketPath,
    invocation: { claudeConfigDir, defaultModel: config.model },
    spawn: { cliPath: config.cliPath, cwd: config.cliCwd },
    maxTimeoutMs: config.timeoutMs,
    onEvent: (event) => {
      if (event.type === 'listening') {
        console.warn(
          `[llm-runner] bereit auf ${event.socketPath} (Profil ${claudeConfigDir}, CLI ${config.cliPath})`,
        );
      } else if (event.type === 'call') {
        console.warn(`[llm-runner] Aufruf ${event.model} in ${event.durationMs} ms`);
      } else {
        console.error(`[llm-runner] Fehler: ${event.message}`);
      }
    },
  });

  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
