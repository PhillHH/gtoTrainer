import { describe, expect, it } from 'vitest';
import { createAnthropicApiProvider } from '../../src/llm/api-provider.js';
import { createClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { loadLlmConfig } from '../../src/config/env.js';

/**
 * Live-Smoke gegen die **echten** Anbieter - je Adapter einer.
 *
 * Laeuft nur mit `LLM_LIVE_SMOKE=true`; in der CI ist die Variable nicht
 * gesetzt und beide Bloecke werden uebersprungen. Grund: Jeder Aufruf
 * verbraucht Kontingent bzw. Guthaben. Deshalb bleiben Prompt und
 * Token-Limit winzig.
 *
 *   LLM_LIVE_SMOKE=true pnpm --filter @gto/backend test test/llm/live-smoke.test.ts
 */
const live = process.env['LLM_LIVE_SMOKE'] === 'true';

const SMOKE_MODEL = process.env['LLM_SMOKE_MODEL'] ?? 'claude-haiku-4-5';

const COLOR_SCHEMA = {
  type: 'object',
  properties: { farbe: { type: 'string' } },
  required: ['farbe'],
  additionalProperties: false,
} as const;

describe.skipIf(!live)('Live-Smoke Adapter A (Claude CLI, Profil B)', () => {
  it('beantwortet einen einfachen Textaufruf', async () => {
    const provider = createClaudeCliProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte mit genau einem Wort.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Antworte nur mit OK' }] }],
      model: SMOKE_MODEL,
      // Die CLI bricht ab, statt zu kuerzen, wenn die Antwort das Limit
      // sprengt - deshalb knapp, aber nicht zu knapp.
      maxTokens: 1024,
      timeoutMs: 120_000,
    });

    expect(response.text.trim().toUpperCase()).toContain('OK');
    expect(response.meta.provider).toBe('cli');
    expect(response.meta.durationMs).toBeGreaterThan(0);
    console.warn('[live-smoke cli] text:', JSON.stringify(response.text), response.meta);
  }, 180_000);

  it('liefert strukturierte Ausgabe gegen ein Schema', async () => {
    const provider = createClaudeCliProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte knapp und sachlich.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Welche Farbe hat klarer Himmel?' }] },
      ],
      model: SMOKE_MODEL,
      maxTokens: 1024,
      timeoutMs: 120_000,
      jsonSchema: COLOR_SCHEMA,
    });

    expect(response.json).toMatchObject({ farbe: expect.any(String) });
    console.warn('[live-smoke cli] json:', JSON.stringify(response.json), response.meta);
  }, 180_000);
});

describe.skipIf(!live)('Live-Smoke Adapter B (Anthropic Messages API)', () => {
  /**
   * Ohne Schluessel wird **uebersprungen, nicht bestanden** - mit sichtbarer
   * Meldung, damit die Auslassung im Protokoll nicht untergeht.
   */
  function requireKeyOrSkip(context: { skip: () => void }): boolean {
    if (loadLlmConfig().apiKey !== undefined) return true;
    console.warn(
      '[live-smoke api] UEBERSPRUNGEN: kein ANTHROPIC_API_KEY gesetzt. ' +
        'Nachholen mit: ANTHROPIC_API_KEY=sk-ant-... LLM_LIVE_SMOKE=true ' +
        'pnpm --filter @gto/backend exec vitest run test/llm/live-smoke.test.ts',
    );
    context.skip();
    return false;
  }

  it('beantwortet einen einfachen Textaufruf', async (context) => {
    if (!requireKeyOrSkip(context)) return;

    const provider = createAnthropicApiProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte mit genau einem Wort.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Antworte nur mit OK' }] }],
      model: SMOKE_MODEL,
      maxTokens: 1024,
      timeoutMs: 120_000,
    });

    expect(response.text.trim().toUpperCase()).toContain('OK');
    expect(response.meta.provider).toBe('api');
    expect(response.meta.totalTokens).toBeGreaterThan(0);
    console.warn('[live-smoke api] text:', JSON.stringify(response.text), response.meta);
  }, 180_000);

  it('liefert strukturierte Ausgabe gegen ein Schema', async (context) => {
    if (!requireKeyOrSkip(context)) return;

    const provider = createAnthropicApiProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte knapp und sachlich.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Welche Farbe hat klarer Himmel?' }] },
      ],
      model: SMOKE_MODEL,
      maxTokens: 1024,
      timeoutMs: 120_000,
      jsonSchema: COLOR_SCHEMA,
    });

    expect(response.json).toMatchObject({ farbe: expect.any(String) });
    console.warn('[live-smoke api] json:', JSON.stringify(response.json), response.meta);
  }, 180_000);
});
