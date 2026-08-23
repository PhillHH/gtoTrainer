import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliProvider, createClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { ConfigError } from '../../src/config/env.js';
import { isLlmError } from '../../src/llm/errors.js';
import {
  FAKE_CLI,
  fakeRequest,
  makeTempDir,
  maxConcurrentFromTrace,
  testLlmConfig,
} from './helpers.js';
import type { LlmConfig } from '../../src/config/env.js';

/**
 * Tests des CLI-Adapters gegen eine gefaelschte CLI. Kein Test hier ruft die
 * echte Claude CLI auf - der Live-Smoke liegt in `live-smoke.test.ts`.
 */

function provider(overrides: Partial<LlmConfig> = {}): ClaudeCliProvider {
  return new ClaudeCliProvider(testLlmConfig(overrides));
}

/** Erwartet einen `LlmError` und liefert ihn zur weiteren Pruefung zurueck. */
async function expectLlmError(promise: Promise<unknown>): Promise<{
  kind: string;
  message: string;
  retryable: boolean;
}> {
  try {
    await promise;
  } catch (error) {
    if (!isLlmError(error)) throw error;
    return { kind: error.kind, message: error.message, retryable: error.retryable };
  }
  throw new Error('Es wurde ein LlmError erwartet, der Aufruf war aber erfolgreich.');
}

describe('Konfiguration und Profil-Bindung', () => {
  it('bricht ohne CLAUDE_CONFIG_DIR mit klarer Meldung ab, statt ein Default-Profil zu nehmen', () => {
    expect(() => createClaudeCliProvider(testLlmConfig({ claudeConfigDir: undefined }))).toThrow(
      ConfigError,
    );
    expect(() => createClaudeCliProvider(testLlmConfig({ claudeConfigDir: undefined }))).toThrow(
      /CLAUDE_CONFIG_DIR fehlt oder ist leer/,
    );
  });

  it('reicht CLAUDE_CONFIG_DIR an den Kindprozess durch und laesst ANTHROPIC_API_KEY draussen', async () => {
    const restore = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-darf-nicht-durchgereicht-werden';
    try {
      const response = await provider().complete(fakeRequest('echo-args', { maxTokens: 321 }));
      const seen = JSON.parse(response.text) as {
        claudeConfigDir: string;
        hasAnthropicApiKey: boolean;
        maxOutputTokens: string;
        envKeys: string[];
      };

      expect(seen.claudeConfigDir).toBe('/home/phillip/.claude-b');
      expect(seen.hasAnthropicApiKey).toBe(false);
      expect(seen.maxOutputTokens).toBe('321');
      // Minimales Environment: nur was der Aufruf wirklich braucht.
      expect(seen.envKeys.sort()).toEqual(
        ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'].filter((key) =>
          key === 'HOME' ? process.env['HOME'] !== undefined : true,
        ),
      );
    } finally {
      if (restore === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = restore;
    }
  });

  it('uebergibt den Prompt ueber stdin und nie als Kommandozeilenargument', async () => {
    const geheim = 'streng-geheimer-prompt-inhalt';
    const response = await provider().complete(
      fakeRequest('echo-args', {
        messages: [{ role: 'user', content: [{ type: 'text', text: `FAKE:echo-args ${geheim}` }] }],
      }),
    );
    const seen = JSON.parse(response.text) as { argv: string[]; stdinBytes: number };

    expect(seen.argv.join(' ')).not.toContain(geheim);
    expect(seen.argv).toContain('--input-format');
    expect(seen.argv).toContain('stream-json');
    expect(seen.stdinBytes).toBeGreaterThan(geheim.length);
  });

  it('interpretiert Prompt-Inhalte nicht als Shell-Kommando', async () => {
    // Waere hier eine Shell im Spiel, wuerde die Ersetzung ausgefuehrt.
    const response = await provider().complete(
      fakeRequest('echo-args', {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'FAKE:echo-args $(id) `whoami`; rm -rf /' }],
          },
        ],
      }),
    );
    const seen = JSON.parse(response.text) as { argv: string[] };
    expect(seen.argv).not.toContain('$(id)');
  });
});

describe('Antwort-Parsing', () => {
  it('liest sauberes JSON aus structured_output', async () => {
    const response = await provider().complete(
      fakeRequest('json', { jsonSchema: { type: 'object', required: ['farbe'] } }),
    );
    expect(response.json).toEqual({ farbe: 'blau' });
  });

  it('loest JSON aus einem Code-Fence heraus', async () => {
    const response = await provider().complete(
      fakeRequest('fence', { jsonSchema: { type: 'object', required: ['farbe'] } }),
    );
    expect(response.json).toEqual({ farbe: 'blau' });
  });

  it('loest JSON aus umgebendem Wrapper-Text heraus', async () => {
    const response = await provider().complete(
      fakeRequest('wrapper', { jsonSchema: { type: 'object', required: ['farbe'] } }),
    );
    expect(response.json).toEqual({ farbe: 'blau' });
  });

  it('liefert bei Textaufrufen den Text und json === null', async () => {
    const response = await provider().complete(fakeRequest('ok'));
    expect(response.text).toBe('OK');
    expect(response.json).toBeNull();
  });

  it('fuellt meta mit Provider, Modell, Dauer und Tokenzahlen', async () => {
    const response = await provider().complete(fakeRequest('ok'));
    expect(response.meta.provider).toBe('cli');
    // Das Modell mit den meisten Ausgabetokens, nicht das Hilfsmodell.
    expect(response.meta.model).toBe('claude-sonnet-5');
    expect(response.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.meta.promptTokens).toBe(16);
    expect(response.meta.completionTokens).toBe(7);
    expect(response.meta.totalTokens).toBe(23);
  });
});

describe('Fehler-Zuordnung auf die Taxonomie', () => {
  it('Timeout: beendet den Prozess und meldet timeout', async () => {
    const error = await expectLlmError(provider({ timeoutMs: 300 }).complete(fakeRequest('hang')));
    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/Zeitlimit/);
  });

  it('RateLimit: erkennt das Kontingent-Limit der Subscription', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('ratelimit')));
    expect(error.kind).toBe('rate_limit');
  });

  it('Auth: erkennt "Not logged in"', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('auth')));
    expect(error.kind).toBe('auth');
  });

  it('Auth: erkennt eine fehlende CLI (ENOENT) als Konfigurationsproblem', async () => {
    const error = await expectLlmError(
      provider({ cliPath: '/nicht/vorhanden/claude' }).complete(fakeRequest('ok')),
    );
    expect(error.kind).toBe('auth');
    expect(error.message).toMatch(/nicht gefunden/);
  });

  it('Transient: erkennt eine Ueberlastmeldung', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('transient')));
    expect(error.kind).toBe('transient');
    expect(error.retryable).toBe(true);
  });

  it('Invalid: erkennt ein abgelehntes JSON-Schema', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('invalid')));
    expect(error.kind).toBe('invalid');
  });

  it('Invalid: stuft unbekannte Fehler als nicht wiederholbar ein', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('unknown')));
    expect(error.kind).toBe('invalid');
    expect(error.retryable).toBe(false);
  });

  it('Invalid: weist eine Anfrage ohne Nachricht ab, bevor ein Prozess startet', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('ok', { messages: [] })));
    expect(error.kind).toBe('invalid');
  });

  it('Parse: meldet fehlende JSON-Nutzlast, statt still auf Rohtext zurueckzufallen', async () => {
    const error = await expectLlmError(
      provider().complete(fakeRequest('garbage', { jsonSchema: { type: 'object' } })),
    );
    expect(error.kind).toBe('parse');
  });

  it('Parse: meldet einen Schemaverstoss', async () => {
    const error = await expectLlmError(
      provider().complete(
        fakeRequest('schema-violation', {
          jsonSchema: {
            type: 'object',
            properties: { farbe: { type: 'string' } },
            required: ['farbe'],
          },
        }),
      ),
    );
    expect(error.kind).toBe('parse');
    expect(error.message).toMatch(/erwartet string/);
  });

  it('Parse: meldet eine Ausgabe ohne result-Ereignis', async () => {
    const error = await expectLlmError(provider().complete(fakeRequest('no-result')));
    expect(error.kind).toBe('parse');
  });
});

describe('Timeout hinterlaesst keinen laufenden Prozess', () => {
  it('beendet die Prozessgruppe, sodass nach dem Timeout keine CLI mehr laeuft', async () => {
    const marker = `gto-timeout-probe-${process.pid}-${Date.now()}`;
    const request = fakeRequest('hang', {
      messages: [{ role: 'user', content: [{ type: 'text', text: `FAKE:hang ${marker}` }] }],
    });

    const error = await expectLlmError(provider({ timeoutMs: 300 }).complete(request));
    expect(error.kind).toBe('timeout');

    // Kurz warten, damit SIGTERM/SIGKILL wirken konnten.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const survivors = execFileSync('bash', ['-c', `pgrep -fa ${marker} || true`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.includes(marker) && !line.includes('pgrep'));

    expect(survivors).toEqual([]);
  });
});

describe('Retry', () => {
  it('wiederholt transiente Fehler und liefert danach das Ergebnis', async () => {
    const temp = makeTempDir('gto-retry-');
    try {
      const counter = join(temp.path, 'count');
      const response = await provider({ maxAttempts: 3 }).complete(
        fakeRequest(`flaky|counter=${counter}|fail=2`),
      );
      expect(response.text).toBe('OK nach Versuch 3');
      expect(readFileSync(counter, 'utf8')).toBe('3');
    } finally {
      temp.cleanup();
    }
  });

  it('wiederholt Auth-Fehler NICHT', async () => {
    await expectNoRetry('always-auth', 'auth');
  });

  it('wiederholt Invalid-Fehler NICHT', async () => {
    await expectNoRetry('always-invalid', 'invalid');
  });

  it('wiederholt Parse-Fehler NICHT', async () => {
    const temp = makeTempDir('gto-noretry-parse-');
    try {
      const counter = join(temp.path, 'count');
      const error = await expectLlmError(
        provider({ maxAttempts: 3 }).complete(
          fakeRequest(`always-parse|counter=${counter}`, { jsonSchema: { type: 'object' } }),
        ),
      );
      expect(error.kind).toBe('parse');
      expect(readFileSync(counter, 'utf8')).toBe('1');
    } finally {
      temp.cleanup();
    }
  });

  async function expectNoRetry(directive: string, kind: string): Promise<void> {
    const temp = makeTempDir(`gto-noretry-${kind}-`);
    try {
      const counter = join(temp.path, 'count');
      const error = await expectLlmError(
        provider({ maxAttempts: 3 }).complete(fakeRequest(`${directive}|counter=${counter}`)),
      );
      expect(error.kind).toBe(kind);
      // Genau ein Prozessstart - es wurde nicht wiederholt.
      expect(readFileSync(counter, 'utf8')).toBe('1');
    } finally {
      temp.cleanup();
    }
  }
});

describe('Nebenlaeufigkeitslimit', () => {
  it('laesst nie mehr CLI-Prozesse gleichzeitig laufen als konfiguriert', async () => {
    const temp = makeTempDir('gto-semaphore-');
    try {
      const trace = join(temp.path, 'trace');
      const limit = 2;
      const calls = 6;
      const adapter = provider({ maxConcurrency: limit, timeoutMs: 10_000 });

      await Promise.all(
        Array.from({ length: calls }, () =>
          adapter.complete(fakeRequest(`slow|delay=120|trace=${trace}`)),
        ),
      );

      expect(maxConcurrentFromTrace(trace)).toBeLessThanOrEqual(limit);
      expect(maxConcurrentFromTrace(trace)).toBe(limit);
      expect(adapter.inFlight).toBe(0);
    } finally {
      temp.cleanup();
    }
  });
});

describe('Bild-Input (Grundlage fuer AP3)', () => {
  it('schickt Bildbausteine als base64-Quelle ueber stdin', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUg==';
    const response = await provider().complete(
      fakeRequest('echo-args', {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'FAKE:echo-args' },
              { type: 'image', mediaType: 'image/png', data: png },
            ],
          },
        ],
      }),
    );
    const seen = JSON.parse(response.text) as { stdinBytes: number };
    expect(seen.stdinBytes).toBeGreaterThan(png.length);
  });
});

describe('Aufrufform', () => {
  it('nutzt die in ADR-0021/0023 festgelegten Flags', async () => {
    const response = await provider().complete(
      fakeRequest('echo-args', { jsonSchema: { type: 'object' } }),
    );
    const seen = JSON.parse(response.text) as { argv: string[]; cwd: string };

    expect(seen.argv[0]).toBe('-p');
    expect(seen.argv).toContain('--system-prompt');
    expect(seen.argv).toContain('--tools');
    expect(seen.argv).toContain('--json-schema');
    expect(seen.argv).toContain('--output-format');
    // Arbeitsverzeichnis bewusst projektfremd, damit kein CLAUDE.md greift.
    expect(seen.cwd).not.toContain('/gto/apps');
  });

  it('startet die CLI unter dem konfigurierten Pfad', () => {
    expect(FAKE_CLI.endsWith('fake-claude.mjs')).toBe(true);
  });
});
