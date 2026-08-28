import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyCorrections,
  foldConceptMastery,
  foldErrorLog,
  foldReviewQueue,
  foldSkillRating,
  inEventOrder,
} from '../../src/learning/derive.js';
import type { StoredLearningEvent } from '../../src/learning/derive.js';

/**
 * Die Determinismus-Regel der Ableitungen (AP4.T4.2) - als Test, nicht als
 * Zusage in der Doku.
 *
 * Sie gilt **bindend fuer T4.3 bis T4.5**: Wer dort die Formeln ersetzt und
 * dabei zur Systemzeit greift, faellt hier auf, statt den Replay still
 * unbrauchbar zu machen.
 */

const DERIVE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/learning/derive.ts', import.meta.url)),
  'utf8',
);

/**
 * Seit T4.3 steht die Mastery-Formel in einem eigenen Modul - die Regel gilt
 * dort genauso. Ausgenommen ist `evaluateAdvance`: Es bekommt den
 * Bezugszeitpunkt als `asOf`-Argument herein, statt ihn sich zu nehmen.
 */
const MASTERY_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/learning/mastery.ts', import.meta.url)),
  'utf8',
);

/** Kommentarzeilen zaehlen nicht - die Regel steht dort im Klartext. */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
  });
}

const FORBIDDEN = [/\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/, /\bMath\.random\s*\(/];

function forbiddenCalls(source: string): string[] {
  return codeLines(source).filter((line) => FORBIDDEN.some((pattern) => pattern.test(line)));
}

describe('Determinismus der Ableitungen (AP4.T4.2)', () => {
  it('benutzt weder Systemzeit noch Zufall', () => {
    expect(forbiddenCalls(DERIVE_SOURCE)).toEqual([]);
  });

  it('gilt auch fuer die Mastery-Formel aus T4.3', () => {
    expect(forbiddenCalls(MASTERY_SOURCE)).toEqual([]);
    // Der Bezugszeitpunkt der Konfidenz-Veralterung kommt als Argument herein.
    expect(MASTERY_SOURCE).toContain('readonly asOf: Date;');
    expect(MASTERY_SOURCE).not.toMatch(/from '\.\.\/db\//);
  });

  it('leitet jeden Zeitbezug aus dem Ereignis ab', () => {
    // Das einzige `new Date(...)` im Modul rechnet auf `occurredAt` weiter.
    const dateCalls = codeLines(DERIVE_SOURCE).filter((line) => line.includes('new Date('));
    expect(dateCalls).toHaveLength(1);
    expect(dateCalls[0]).toContain('occurredAt.getTime()');
  });

  it('greift nicht auf die Datenbank zu', () => {
    // Reine Funktionen: kein Import aus dem Datenbankumfeld.
    expect(DERIVE_SOURCE).not.toMatch(/from '\.\.\/db\//);
    expect(DERIVE_SOURCE).not.toMatch(/drizzle-orm/);
  });

  it('liefert bei zweimaliger Anwendung auf denselben Strom dasselbe Ergebnis', () => {
    const events = stream();
    const first = project(events);
    // Umgedrehte Eingabereihenfolge: `inEventOrder` muss sie egalisieren.
    const second = project([...events].reverse());
    expect(second).toEqual(first);
  });

  it('bricht Gleichstaende beim Zeitpunkt reproduzierbar ueber die Ereignis-ID', () => {
    const sameTime = new Date('2026-08-20T08:00:00.000Z');
    const a = anEvent({ id: 'aaaaaaaa-0000-4000-8000-000000000000', occurredAt: sameTime });
    const b = anEvent({ id: 'bbbbbbbb-0000-4000-8000-000000000000', occurredAt: sameTime });

    expect(inEventOrder([b, a]).map((event) => event.id)).toEqual([a.id, b.id]);
    expect(inEventOrder([a, b]).map((event) => event.id)).toEqual([a.id, b.id]);
  });
});

function project(events: readonly StoredLearningEvent[]): unknown {
  const effective = applyCorrections(inEventOrder(events));
  return {
    mastery: foldConceptMastery(effective),
    queue: foldReviewQueue(effective),
    errors: foldErrorLog(effective),
    rating: foldSkillRating(effective),
  };
}

function anEvent(overrides: Partial<StoredLearningEvent> = {}): StoredLearningEvent {
  return {
    id: '11111111-0000-4000-8000-000000000000',
    eventType: 'question_answered',
    source: 'theory_session',
    signalClass: 'objective',
    occurredAt: new Date('2026-08-20T08:00:00.000Z'),
    conceptId: '99999999-0000-4000-8000-000000000000',
    chartId: null,
    correctsEventId: null,
    payload: { correct: true },
    ...overrides,
  };
}

/** Ein kleiner Strom mit Erfolg, Fehlschlag und Korrektur. */
function stream(): readonly StoredLearningEvent[] {
  const failed = anEvent({
    id: '22222222-0000-4000-8000-000000000000',
    eventType: 'drill_completed',
    source: 'drill',
    occurredAt: new Date('2026-08-20T09:00:00.000Z'),
    payload: { correct: 0, total: 4 },
  });
  return [
    anEvent(),
    failed,
    anEvent({
      id: '33333333-0000-4000-8000-000000000000',
      eventType: 'manual_correction',
      source: 'manual',
      signalClass: 'self_reported',
      occurredAt: new Date('2026-08-20T10:00:00.000Z'),
      correctsEventId: failed.id,
      payload: { reason: 'Chart war falsch.', replacementOutcome: 0.75 },
    }),
  ];
}
