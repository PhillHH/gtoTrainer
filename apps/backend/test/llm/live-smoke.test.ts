import { describe, expect, it } from 'vitest';
import { createClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { loadLlmConfig } from '../../src/config/env.js';

/**
 * Live-Smoke gegen die **echte** Claude CLI und Profil B.
 *
 * Laeuft nur mit `LLM_LIVE_SMOKE=true` - in der CI ist die Variable nicht
 * gesetzt, der Block wird dort uebersprungen. Grund: Jeder Aufruf verbraucht
 * Subscription-Kontingent. Deshalb bleiben Prompt und Token-Limit winzig.
 *
 *   LLM_LIVE_SMOKE=true pnpm --filter @gto/backend test test/llm/live-smoke.test.ts
 */
const live = process.env['LLM_LIVE_SMOKE'] === 'true';

describe.skipIf(!live)('Live-Smoke gegen Profil B', () => {
  it('beantwortet einen einfachen Textaufruf', async () => {
    const provider = createClaudeCliProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte mit genau einem Wort.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Antworte nur mit OK' }] }],
      model: process.env['LLM_MODEL'] ?? 'claude-haiku-4-5',
      // Die CLI bricht ab, statt zu kuerzen, wenn die Antwort das Limit
      // sprengt - deshalb knapp, aber nicht zu knapp.
      maxTokens: 1024,
      timeoutMs: 120_000,
    });

    expect(response.text.trim().toUpperCase()).toContain('OK');
    expect(response.meta.provider).toBe('cli');
    expect(response.meta.durationMs).toBeGreaterThan(0);
    console.warn('[live-smoke] text:', JSON.stringify(response.text), response.meta);
  }, 180_000);

  it('liefert strukturierte Ausgabe gegen ein Schema', async () => {
    const provider = createClaudeCliProvider(loadLlmConfig());
    const response = await provider.complete({
      system: 'Antworte knapp und sachlich.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Welche Farbe hat klarer Himmel?' }] },
      ],
      model: process.env['LLM_MODEL'] ?? 'claude-haiku-4-5',
      maxTokens: 1024,
      timeoutMs: 120_000,
      jsonSchema: {
        type: 'object',
        properties: { farbe: { type: 'string' } },
        required: ['farbe'],
        additionalProperties: false,
      },
    });

    expect(response.json).toMatchObject({ farbe: expect.any(String) });
    console.warn('[live-smoke] json:', JSON.stringify(response.json), response.meta);
  }, 180_000);
});
