import { describe, expect, it } from 'vitest';
import { CONCEPT_SUGGESTION_SCHEMA } from '@gto/shared';
import type { ConceptSuggestion } from '@gto/shared';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import { conceptSlug, normalizeSuggestions } from '../../src/concept/normalize.js';
import { resolvePrerequisiteTitles, resolveSectionKeys } from '../../src/concept/resolve.js';

function suggestion(overrides: Partial<ConceptSuggestion> = {}): ConceptSuggestion {
  return {
    titel: 'Minimum Defense Frequency',
    kurzdefinition:
      'Der Anteil einer Range, den man verteidigen muss, damit ein Bluff nicht profitabel wird.',
    themenbereich: 'spieltheorie',
    ab_level: 'fortgeschritten',
    voraussetzungen: [],
    sektionen: ['ch02/mdf'],
    ...overrides,
  };
}

describe('Konzept-Schluessel', () => {
  it('behandelt Schreibvarianten als denselben Begriff', () => {
    expect(conceptSlug('Minimum Defense Frequency (MDF)')).toBe(
      conceptSlug('minimum  defense frequency'),
    );
  });

  it('streicht einen fuehrenden Artikel', () => {
    expect(conceptSlug('Die Nash-Gleichgewichtsstrategie')).toBe(
      conceptSlug('Nash Gleichgewichtsstrategie'),
    );
  });

  it('normalisiert Umlaute', () => {
    expect(conceptSlug('Überbetting')).toBe('ueberbetting');
  });
});

describe('Vorschlaege normalisieren', () => {
  it('uebernimmt einen gueltigen Vorschlag', () => {
    const result = normalizeSuggestions([suggestion()]);
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0]).toMatchObject({
      slug: 'minimum-defense-frequency',
      topicArea: 'spieltheorie',
      minLevel: 'fortgeschritten',
    });
    expect(result.rejected).toEqual([]);
  });

  it('lehnt einen unbekannten Themenbereich ab, statt ihn umzubiegen', () => {
    const result = normalizeSuggestions([suggestion({ themenbereich: 'irgendwas' })]);
    expect(result.concepts).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('Unbekannter Themenbereich');
  });

  it('lehnt ein unbekanntes Level ab', () => {
    const result = normalizeSuggestions([suggestion({ ab_level: 'profi' })]);
    expect(result.concepts).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('Unbekanntes Level');
  });

  it('verwirft einen Vorschlag ohne Kurzdefinition', () => {
    const result = normalizeSuggestions([suggestion({ kurzdefinition: '   ' })]);
    expect(result.concepts).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('Kurzdefinition');
  });

  it('erkennt eine Dublette innerhalb desselben Laufs', () => {
    const result = normalizeSuggestions([
      suggestion(),
      suggestion({ titel: 'Minimum Defense Frequency (MDF)' }),
    ]);
    expect(result.concepts).toHaveLength(1);
    expect(result.merged).toHaveLength(1);
  });

  it('erkennt eine Dublette gegen bereits bekannte Konzepte anderer Kapitel', () => {
    const result = normalizeSuggestions([suggestion()], new Set(['minimum-defense-frequency']));
    expect(result.concepts).toEqual([]);
    expect(result.merged[0]?.reason).toContain('Dublette');
  });

  it('entfernt Dubletten in Voraussetzungen und Sektionen', () => {
    const result = normalizeSuggestions([
      suggestion({
        voraussetzungen: ['Position', 'Position', ' '],
        sektionen: ['ch02/mdf', 'ch02/mdf'],
      }),
    ]);
    expect(result.concepts[0]?.prerequisiteTitles).toEqual(['Position']);
    expect(result.concepts[0]?.sectionKeys).toEqual(['ch02/mdf']);
  });
});

describe('Referenzen aufloesen', () => {
  const bySlug = new Map([
    ['position-am-tisch', 'id-position'],
    ['pot-odds', 'id-potodds'],
  ]);

  it('loest Titel-Referenzen auf IDs auf', () => {
    const result = resolvePrerequisiteTitles(['Position am Tisch', 'Pot Odds'], bySlug);
    expect(result.ids).toEqual(['id-position', 'id-potodds']);
    expect(result.unresolved).toEqual([]);
  });

  it('haelt eine nicht aufloesbare Referenz fest, statt sie zu verwerfen', () => {
    const result = resolvePrerequisiteTitles(['Position am Tisch', 'Gibt es nicht'], bySlug);
    expect(result.ids).toEqual(['id-position']);
    expect(result.unresolved).toEqual(['Gibt es nicht']);
  });

  it('verwirft einen Selbstverweis', () => {
    const result = resolvePrerequisiteTitles(['Position am Tisch'], bySlug, 'id-position');
    expect(result.ids).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('loest Sektionsschluessel auf, auch ohne Kapitelpraefix', () => {
    const byKey = new Map([
      ['ch02/mdf', 'sec-1'],
      ['ch02/nash', 'sec-2'],
    ]);
    const result = resolveSectionKeys(['ch02/mdf', 'nash', 'ch09/unbekannt'], byKey);
    expect(result.ids).toEqual(['sec-1', 'sec-2']);
    expect(result.unresolved).toEqual(['ch09/unbekannt']);
  });
});

describe('Ausgabeschema des Templates', () => {
  it('entspricht exakt dem Vertrag in packages/shared', () => {
    // Ein Template ist eine Datei und kann den TypeScript-Vertrag nicht
    // importieren. Dieser Test haelt beide Fassungen deckungsgleich - sonst
    // erzwingt der Prompt etwas anderes, als der Code erwartet.
    const template = TemplateRegistry.load().get('task/concept-taxonomy');
    expect(template.meta.jsonSchema).toEqual(
      JSON.parse(JSON.stringify(CONCEPT_SUGGESTION_SCHEMA)) as unknown,
    );
  });
});
