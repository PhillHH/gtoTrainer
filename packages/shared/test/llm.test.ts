import { describe, expect, it } from 'vitest';
import {
  LLM_ERROR_KINDS,
  LLM_ERROR_RETRYABLE,
  LLM_IMAGE_MEDIA_TYPES,
  LLM_PROVIDER_IDS,
  isLlmErrorKind,
  isLlmErrorRetryable,
  isLlmProviderId,
} from '../src/index.js';
import type {
  LLMProvider,
  LlmErrorKind,
  LlmErrorPayload,
  LlmRequest,
  LlmResponse,
} from '../src/index.js';

/**
 * Vertragstests des LLM-Gateways. Bewusst **ohne** Netzwerk- oder
 * Prozessaufrufe - hier wird nur die Form des Vertrags geprueft.
 */

describe('Provider-Kennung', () => {
  it('kennt genau die beiden Adapter aus AP2', () => {
    expect(LLM_PROVIDER_IDS).toEqual(['cli', 'api']);
  });

  it('weist unbekannte Kennungen zurueck', () => {
    expect(isLlmProviderId('cli')).toBe(true);
    expect(isLlmProviderId('api')).toBe(true);
    expect(isLlmProviderId('openai')).toBe(false);
    expect(isLlmProviderId(null)).toBe(false);
    expect(isLlmProviderId(undefined)).toBe(false);
  });
});

describe('Fehler-Taxonomie', () => {
  it('ist geschlossen und vollstaendig', () => {
    expect([...LLM_ERROR_KINDS].sort()).toEqual(
      ['auth', 'invalid', 'parse', 'rate_limit', 'timeout', 'transient'].sort(),
    );
  });

  it('legt fuer jede Kategorie die Retry-Faehigkeit fest', () => {
    for (const kind of LLM_ERROR_KINDS) {
      expect(typeof LLM_ERROR_RETRYABLE[kind]).toBe('boolean');
    }
    expect(Object.keys(LLM_ERROR_RETRYABLE).sort()).toEqual([...LLM_ERROR_KINDS].sort());
  });

  it('trennt wiederholbare von endgueltigen Fehlern', () => {
    expect(isLlmErrorRetryable('timeout')).toBe(true);
    expect(isLlmErrorRetryable('rate_limit')).toBe(true);
    expect(isLlmErrorRetryable('transient')).toBe(true);
    expect(isLlmErrorRetryable('auth')).toBe(false);
    expect(isLlmErrorRetryable('invalid')).toBe(false);
    expect(isLlmErrorRetryable('parse')).toBe(false);
  });

  it('erkennt gueltige Kategorien zur Laufzeit', () => {
    expect(isLlmErrorKind('rate_limit')).toBe(true);
    expect(isLlmErrorKind('RATE_LIMIT')).toBe(false);
    expect(isLlmErrorKind('unknown')).toBe(false);
    expect(isLlmErrorKind(42)).toBe(false);
  });

  it('behandelt jede Kategorie erschoepfend - eine neue bricht die Uebersetzung', () => {
    // Die Zuordnung ist absichtlich ohne `default`-Zweig geschrieben. Kommt
    // eine siebte Kategorie hinzu, ist `kind` im letzten Zweig nicht mehr
    // `never` und `tsc` meldet den Fehler hier - nicht erst im Betrieb.
    const beschreibe = (kind: LlmErrorKind): string => {
      switch (kind) {
        case 'timeout':
          return 'Zeitueberschreitung';
        case 'rate_limit':
          return 'Kontingent erschoepft';
        case 'auth':
          return 'Anmeldung oder Konfiguration';
        case 'transient':
          return 'voruebergehende Stoerung';
        case 'invalid':
          return 'Anfrage fehlerhaft';
        case 'parse':
          return 'Antwort nicht auswertbar';
        default: {
          const _erschoepfend: never = kind;
          return _erschoepfend;
        }
      }
    };

    expect(LLM_ERROR_KINDS.map(beschreibe)).toHaveLength(LLM_ERROR_KINDS.length);
    expect(beschreibe('parse')).toBe('Antwort nicht auswertbar');
  });

  it('traegt eine Fehlermeldung samt Provider und optionaler Wartezeit', () => {
    const payload: LlmErrorPayload = {
      kind: 'rate_limit',
      provider: 'cli',
      message: "You've hit your session limit",
      retryAfterMs: 45 * 60 * 1000,
    };

    expect(isLlmErrorKind(payload.kind)).toBe(true);
    expect(isLlmErrorRetryable(payload.kind)).toBe(true);
  });
});

describe('Anfrage mit Bild-Input (Scope-Delta 3, Grundlage fuer AP3)', () => {
  it('nimmt Text und Bild in derselben Nachricht auf', () => {
    // 1x1-PNG als Base64 - stellvertretend fuer ein Chart-Rendering aus AP3.
    const chartPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const request: LlmRequest = {
      system: 'Du digitalisierst GTO-Charts.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Lies die Frequenzen aus diesem Chart.' },
            { type: 'image', mediaType: 'image/png', data: chartPng },
          ],
        },
      ],
      model: 'claude-sonnet-5',
      maxTokens: 4096,
      jsonSchema: {
        type: 'object',
        properties: { raise: { type: 'number' } },
        required: ['raise'],
      },
      timeoutMs: 120_000,
    };

    const [message] = request.messages;
    expect(message).toBeDefined();
    expect(message?.content).toHaveLength(2);
    expect(message?.content[1]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: chartPng,
    });
    expect(LLM_IMAGE_MEDIA_TYPES).toContain('image/png');
  });

  it('erlaubt einen mehrstufigen Verlauf aus Text und Bild', () => {
    const request: LlmRequest = {
      system: 'Bewertungs-Persona',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Erste Frage' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Erste Antwort' }] },
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }],
        },
      ],
      model: 'opus',
      maxTokens: 1024,
    };

    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('Antwort und Begleitdaten', () => {
  it('deckt die Spalten ab, die llm_call_log erwartet', () => {
    const response: LlmResponse<{ raise: number }> = {
      text: '{"raise":0.42}',
      json: { raise: 0.42 },
      meta: {
        provider: 'cli',
        model: 'claude-sonnet-5',
        durationMs: 2137,
        promptTokens: 2,
        completionTokens: 60,
        totalTokens: 62,
      },
    };

    // provider, model, duration_ms, prompt_tokens, completion_tokens, total_tokens
    expect(Object.keys(response.meta).sort()).toEqual([
      'completionTokens',
      'durationMs',
      'model',
      'promptTokens',
      'provider',
      'totalTokens',
    ]);
    expect(isLlmProviderId(response.meta.provider)).toBe(true);
  });

  it('laesst Tokenzahlen offen, wenn der Provider sie nicht ausweist', () => {
    const response: LlmResponse = {
      text: 'OK',
      json: null,
      meta: {
        provider: 'cli',
        model: 'opus',
        durationMs: 812,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };

    expect(response.json).toBeNull();
    expect(response.meta.totalTokens).toBeNull();
  });
});

describe('LLMProvider als einziger KI-Zugang', () => {
  it('laesst sich ohne Netzwerk erfuellen - der Vertrag ist die einzige Bedingung', async () => {
    // Kein Adapter, nur der Nachweis, dass die Signatur implementierbar ist.
    const attrappe: LLMProvider = {
      id: 'api',
      complete: async <TJson>(request: LlmRequest): Promise<LlmResponse<TJson>> => ({
        text: request.system,
        json: null,
        meta: {
          provider: 'api',
          model: request.model,
          durationMs: 0,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
      }),
    };

    const antwort = await attrappe.complete({
      system: 'Lehrer-Persona',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo' }] }],
      model: 'claude-sonnet-5',
      maxTokens: 256,
    });

    expect(antwort.meta.provider).toBe(attrappe.id);
    expect(antwort.text).toBe('Lehrer-Persona');
  });
});
