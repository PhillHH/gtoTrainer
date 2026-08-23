import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadEnvFile, loadLlmConfig } from '../../src/config/env.js';

/**
 * Die LLM-Konfiguration wird bei der Adapter-Initialisierung gelesen, nicht
 * beim Serverstart: Das Backend muss auch ohne CLI starten koennen (CI, und ab
 * T2.3 der reine API-Adapter).
 */

const KEYS = [
  'LLM_TRANSPORT',
  'CLAUDE_CONFIG_DIR',
  'LLM_RUNNER_SOCKET_DIR',
  'LLM_RUNNER_SOCKET_PATH',
  'LLM_MODEL',
  'LLM_MAX_CONCURRENCY',
] as const;

// Erst die .env laden, dann den Ausgangszustand sichern: `loadLlmConfig()`
// wuerde die Datei sonst mitten im Test nachladen und geloeschte Variablen
// wieder herstellen.
loadEnvFile();

const originals = new Map<string, string | undefined>();
for (const key of KEYS) originals.set(key, process.env[key]);

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('loadLlmConfig', () => {
  it('verlangt CLAUDE_CONFIG_DIR, wenn dieser Prozess die CLI selbst startet', () => {
    setEnv({ LLM_TRANSPORT: 'direct', CLAUDE_CONFIG_DIR: undefined });
    expect(() => loadLlmConfig()).toThrow(ConfigError);
    expect(() => loadLlmConfig()).toThrow(/CLAUDE_CONFIG_DIR fehlt oder ist leer/);
    expect(() => loadLlmConfig()).toThrow(/faellt\s+nicht auf ein Default-Profil zurueck/);
  });

  it('behandelt eine leere Variable wie eine fehlende', () => {
    setEnv({ LLM_TRANSPORT: 'direct', CLAUDE_CONFIG_DIR: '   ' });
    expect(() => loadLlmConfig()).toThrow(/CLAUDE_CONFIG_DIR fehlt oder ist leer/);
  });

  it('liest eine vollstaendige direct-Konfiguration', () => {
    setEnv({
      LLM_TRANSPORT: 'direct',
      CLAUDE_CONFIG_DIR: '/home/phillip/.claude-b',
      LLM_MODEL: 'opus',
      LLM_MAX_CONCURRENCY: '3',
    });
    const config = loadLlmConfig();
    expect(config.transport).toBe('direct');
    expect(config.claudeConfigDir).toBe('/home/phillip/.claude-b');
    expect(config.model).toBe('opus');
    expect(config.maxConcurrency).toBe(3);
  });

  it('braucht im Socket-Betrieb kein Profil, aber einen Socketpfad', () => {
    setEnv({
      LLM_TRANSPORT: 'socket',
      CLAUDE_CONFIG_DIR: undefined,
      LLM_RUNNER_SOCKET_DIR: '/run/gto-llm',
    });
    const config = loadLlmConfig();
    expect(config.claudeConfigDir).toBeUndefined();
    expect(config.runnerSocketPath).toBe('/run/gto-llm/gto-llm.sock');
  });

  it('meldet einen fehlenden Socketpfad im Socket-Betrieb', () => {
    setEnv({
      LLM_TRANSPORT: 'socket',
      CLAUDE_CONFIG_DIR: undefined,
      LLM_RUNNER_SOCKET_DIR: undefined,
      LLM_RUNNER_SOCKET_PATH: undefined,
    });
    expect(() => loadLlmConfig()).toThrow(/LLM_RUNNER_SOCKET_PATH oder/);
  });

  it('weist einen unbekannten Transportweg ab', () => {
    setEnv({ LLM_TRANSPORT: 'ssh', CLAUDE_CONFIG_DIR: '/home/phillip/.claude-b' });
    expect(() => loadLlmConfig()).toThrow(/LLM_TRANSPORT muss/);
  });
});
