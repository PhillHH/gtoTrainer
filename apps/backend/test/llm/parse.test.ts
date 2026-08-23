import { describe, expect, it } from 'vitest';
import { extractJson, validateAgainstSchema } from '../../src/llm/parse.js';
import { classifyCliFailure } from '../../src/llm/interpret.js';

describe('extractJson', () => {
  it('nimmt sauberes JSON unveraendert', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('  [1,2,3]  ')).toEqual([1, 2, 3]);
  });

  it('entfernt einen Code-Fence mit und ohne Sprachangabe', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('findet die Nutzlast in umgebendem Wrapper-Text', () => {
    expect(extractJson('Klar doch:\n{"a":1}\nBrauchst du mehr?')).toEqual({ a: 1 });
  });

  it('laesst sich von Klammern in Zeichenketten nicht taeuschen', () => {
    expect(extractJson('Text {"a":"} nicht das Ende {"} Text')).toEqual({
      a: '} nicht das Ende {',
    });
  });

  it('gibt undefined zurueck, wenn nichts Auswertbares da ist', () => {
    expect(extractJson('Dazu faellt mir nichts ein.')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
  });
});

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      farbe: { type: 'string' },
      anzahl: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['farbe'],
    additionalProperties: false,
  };

  it('akzeptiert eine passende Nutzlast', () => {
    expect(validateAgainstSchema({ farbe: 'blau', anzahl: 2, tags: ['x'] }, schema)).toEqual([]);
  });

  it('meldet ein fehlendes Pflichtfeld', () => {
    expect(validateAgainstSchema({ anzahl: 2 }, schema)).toContain('$: Pflichtfeld "farbe" fehlt');
  });

  it('meldet einen falschen Typ mit Pfadangabe', () => {
    expect(validateAgainstSchema({ farbe: 42 }, schema)).toContain(
      '$.farbe: erwartet string, ist number',
    );
  });

  it('meldet ein unerwartetes Feld bei additionalProperties: false', () => {
    expect(validateAgainstSchema({ farbe: 'blau', extra: 1 }, schema)).toContain(
      '$: unerwartetes Feld "extra"',
    );
  });

  it('prueft Array-Elemente einzeln', () => {
    expect(validateAgainstSchema({ farbe: 'blau', tags: ['x', 7] }, schema)).toContain(
      '$.tags[1]: erwartet string, ist number',
    );
  });

  it('prueft enum-Werte', () => {
    expect(validateAgainstSchema('gruen', { type: 'string', enum: ['rot', 'blau'] })).toHaveLength(
      1,
    );
    expect(validateAgainstSchema('rot', { type: 'string', enum: ['rot', 'blau'] })).toEqual([]);
  });
});

describe('classifyCliFailure', () => {
  it('ordnet die in T2.1 beobachteten Meldungen zu', () => {
    expect(classifyCliFailure('Not logged in · Please run /login')).toBe('auth');
    expect(classifyCliFailure("You've hit your weekly limit · resets Mon 12:00am")).toBe(
      'rate_limit',
    );
    expect(classifyCliFailure('API Error: 529 overloaded_error')).toBe('transient');
    expect(classifyCliFailure('Error: --json-schema is not a valid JSON Schema')).toBe('invalid');
  });

  it('stuft Unbekanntes als nicht wiederholbar ein', () => {
    expect(classifyCliFailure('Etwas voellig Neues')).toBe('invalid');
    expect(classifyCliFailure('')).toBe('invalid');
  });
});
