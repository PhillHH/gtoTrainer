import { describe, expectTypeOf, it } from 'vitest';
import type {
  LLMProvider,
  LlmContent,
  LlmErrorKind,
  LlmMessage,
  LlmProviderId,
  LlmRequest,
  LlmResponse,
} from '../src/index.js';

/**
 * Typebenen-Tests. Sie laufen ueber `vitest --typecheck` mit; jede Zeile mit
 * `@ts-expect-error` schlaegt fehl, wenn der Fehler **nicht** mehr auftritt -
 * so faellt eine Aufweichung des Vertrags auf.
 */

describe('Fehlanwendungen des Vertrags werden abgelehnt', () => {
  it('kennt keine weiteren Provider und keine weiteren Fehlerkategorien', () => {
    expectTypeOf<LlmProviderId>().toEqualTypeOf<'cli' | 'api'>();
    expectTypeOf<LlmErrorKind>().toEqualTypeOf<
      'timeout' | 'rate_limit' | 'auth' | 'transient' | 'invalid' | 'parse'
    >();

    // @ts-expect-error 'openai' ist kein zugelassener Provider.
    const provider: LlmProviderId = 'openai';
    void provider;

    // @ts-expect-error 'unknown' ist keine Fehlerkategorie der Taxonomie.
    const kind: LlmErrorKind = 'unknown';
    void kind;
  });

  it('erzwingt Medientyp und Base64-Daten am Bildbaustein', () => {
    const bild: LlmContent = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
    void bild;

    // @ts-expect-error 'image/svg+xml' ist kein zugelassener Medientyp.
    const falscherTyp: LlmContent = { type: 'image', mediaType: 'image/svg+xml', data: 'AAAA' };
    void falscherTyp;

    // @ts-expect-error Ein Bildbaustein ohne `data` ist unvollstaendig.
    const ohneDaten: LlmContent = { type: 'image', mediaType: 'image/png' };
    void ohneDaten;
  });

  it('laesst nur die Rollen user und assistant zu', () => {
    // @ts-expect-error Der System-Prompt ist ein eigenes Feld, keine Rolle.
    const systemAlsRolle: LlmMessage = { role: 'system', content: [] };
    void systemAlsRolle;
  });

  it('verlangt Modell und maxTokens an jeder Anfrage', () => {
    // @ts-expect-error `maxTokens` fehlt.
    const unvollstaendig: LlmRequest = {
      system: 'Persona',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      model: 'opus',
    };
    void unvollstaendig;
  });

  it('haelt die Antwort unveraenderlich und die Tokenzahlen nullable', () => {
    expectTypeOf<LlmResponse['meta']['promptTokens']>().toEqualTypeOf<number | null>();

    const antwort: LlmResponse<{ a: number }> = {
      text: '{"a":1}',
      json: { a: 1 },
      meta: {
        provider: 'cli',
        model: 'opus',
        durationMs: 1,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };

    // @ts-expect-error `meta` ist readonly - Adapter liefern, Aufrufer lesen.
    antwort.meta.model = 'anderes';
  });

  it('bindet die Provider-Kennung an den Adapter', () => {
    expectTypeOf<LLMProvider['id']>().toEqualTypeOf<LlmProviderId>();
    expectTypeOf<LLMProvider['complete']>().returns.resolves.toHaveProperty('meta');
  });
});
