import { describe, expect, it } from 'vitest';
import type { LearningErrorSeverity, LearningEventSource } from '@gto/shared';
import {
  aggregateDigest,
  aggregateErrors,
  countRepeatedAfterReview,
  patternTag,
  renderAggregate,
  startOfUtcWeek,
  trendDirection,
} from '../../src/learning/patterns.js';
import type { ErrorRow, SuccessRow } from '../../src/learning/patterns.js';
import { errorSeverity } from '../../src/learning/derive.js';

/**
 * Aggregation der Fehlerlage (AP4.T4.6) - reine Funktionen, keine Datenbank
 * und **kein KI-Aufruf**.
 *
 * Das hier ist der deterministische Kern vor dem einzigen Aufruf in AP4. Wenn
 * er schief rechnet, deutet die Auswertung anschliessend etwas, das nie
 * passiert ist.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-05T09:00:00.000Z'); // ein Montag
const at = (day: number, hour = 0): Date =>
  new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);

function err(conceptId: string, day: number, overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    eventId: `${conceptId}-${day}-${overrides.eventId ?? ''}`,
    conceptId,
    conceptTitle: `Konzept ${conceptId}`,
    topicArea: 'preflop-verteidigung',
    occurredAt: at(day),
    contextKind: 'drill',
    severity: 'medium',
    ...overrides,
  };
}

describe('Schweregrad-Regel (AP4.T4.6)', () => {
  it('stuft einen chart-verifizierbaren Totalausfall als schwer ein', () => {
    expect(errorSeverity('objective', 0)).toBe<LearningErrorSeverity>('high');
  });

  it('stuft einen teilweisen objektiven Fehlschlag als mittel ein', () => {
    // 1 von 4 richtig zeigt Ansaetze, 0 von 4 zeigt keine.
    expect(errorSeverity('objective', 0.25)).toBe('medium');
    expect(errorSeverity('objective', 0.49)).toBe('medium');
  });

  it('stuft eine KI-Bewertung niedriger ein als einen objektiven Fehler', () => {
    // Eine unzureichende freie Antwort kann auch an der Formulierung liegen -
    // ein Hinweis, kein Beweis.
    expect(errorSeverity('ai_judged', 0)).toBe('medium');
    expect(errorSeverity('ai_judged', 0.3)).toBe('low');
  });

  it('stuft eine Selbsteinschaetzung immer als leicht ein', () => {
    expect(errorSeverity('self_reported', 0)).toBe('low');
    expect(errorSeverity('self_reported', 0.4)).toBe('low');
  });
});

describe('Wiederholte Fehler trotz Wiederholung (AP4.T4.6)', () => {
  it('zaehlt nur Fehler, denen ein Erfolg nach einem frueheren Fehler vorausging', () => {
    // Fehler → Erfolg → Fehler ist etwas anderes als drei Fehler am Stueck:
    // Es sass schon einmal und ist wieder gekippt.
    const errors = [err('a', 0), err('a', 5), err('a', 9)];
    const successes: Date[] = [at(3)];

    // Der Fehler an Tag 0 zaehlt nicht (davor war nichts), die an Tag 5 und 9
    // schon - zwischen dem ersten Fehler und ihnen lag ein Erfolg.
    expect(countRepeatedAfterReview(errors, successes)).toBe(2);
  });

  it('zaehlt nichts, wenn es nie einen Erfolg gab', () => {
    expect(countRepeatedAfterReview([err('a', 0), err('a', 1), err('a', 2)], [])).toBe(0);
  });

  it('zaehlt nichts, wenn der Erfolg vor dem ersten Fehler lag', () => {
    // Erfolg → Fehler → Fehler heisst "war nie sicher", nicht "wieder gekippt".
    expect(countRepeatedAfterReview([err('a', 5), err('a', 7)], [at(1)])).toBe(0);
  });
});

describe('Aggregation (AP4.T4.6)', () => {
  /** Eine konstruierte Fehlerhistorie ueber vier Wochen. */
  function history(): { errors: ErrorRow[]; successes: SuccessRow[] } {
    const errors: ErrorRow[] = [
      // Small Blind: sass zwischendurch, kippt dann wieder - das Kernsignal.
      err('sb', 0, { conceptTitle: 'Small-Blind-Verteidigung', severity: 'high' }),
      err('sb', 8, { conceptTitle: 'Small-Blind-Verteidigung', severity: 'high', eventId: 'b' }),
      err('sb', 15, { conceptTitle: 'Small-Blind-Verteidigung', severity: 'medium', eventId: 'c' }),
      err('sb', 20, { conceptTitle: 'Small-Blind-Verteidigung', severity: 'high', eventId: 'd' }),
      // C-Bet: haeufig, aber ohne Rueckfallmuster; anderer Themenbereich.
      err('cbet', 2, { conceptTitle: 'C-Bet-Frequenz', topicArea: 'flop-spiel' }),
      err('cbet', 3, { conceptTitle: 'C-Bet-Frequenz', topicArea: 'flop-spiel', eventId: 'b' }),
      err('cbet', 4, {
        conceptTitle: 'C-Bet-Frequenz',
        topicArea: 'flop-spiel',
        eventId: 'c',
        contextKind: 'theory_session',
      }),
      // ICM: einzelner leichter Fehler aus der Praxis.
      err('icm', 18, {
        conceptTitle: 'ICM-Druck',
        topicArea: 'turnier-metriken-icm',
        severity: 'low',
        contextKind: 'hand_analysis',
      }),
    ];
    // Ein Erfolg bei "sb" an Tag 5 - zwischen dem ersten und den spaeteren
    // Fehlern.
    const successes: SuccessRow[] = [{ conceptId: 'sb', occurredAt: at(5) }];
    return { errors, successes };
  }

  it('liefert die erwarteten Kennzahlen fuer eine konstruierte Fehlerhistorie', () => {
    const { errors, successes } = history();
    const aggregate = aggregateErrors({
      errors,
      successes,
      periodStart: at(0),
      periodEnd: at(27),
    });

    expect(aggregate.totalErrors).toBe(8);
    expect(aggregate.totalConcepts).toBe(3);
    expect(aggregate.bySeverity).toEqual({ high: 3, medium: 4, low: 1 });

    // Je Konzept, absteigend nach Fehlerzahl.
    expect(aggregate.byConcept.map((stat) => [stat.title, stat.errors])).toEqual([
      ['Small-Blind-Verteidigung', 4],
      ['C-Bet-Frequenz', 3],
      ['ICM-Druck', 1],
    ]);

    // **Das Kernsignal**: drei der vier SB-Fehler kamen nach einem Erfolg.
    expect(
      aggregate.repeatedAfterReview.map((stat) => [stat.title, stat.repeatedAfterReview]),
    ).toEqual([['Small-Blind-Verteidigung', 3]]);

    expect(aggregate.byTopicArea.map((area) => [area.label, area.errors, area.concepts])).toEqual([
      ['Preflop-Verteidigung', 4, 1],
      ['Flop-Spiel', 3, 1],
      ['Turnier-Metriken und ICM', 1, 1],
    ]);

    // Kontexte: Wer in der Theorie sicher ist und im Drill scheitert, hat eine
    // andere Diagnose als umgekehrt.
    expect(aggregate.byContext).toEqual([
      { contextKind: 'drill', errors: 6 },
      { contextKind: 'hand_analysis', errors: 1 },
      { contextKind: 'theory_session', errors: 1 },
    ]);

    // Wochen - **inklusive der leeren**. Eine Luecke ist eine Auskunft: Sie
    // kann "nichts falsch gemacht" heissen oder "nicht geuebt".
    expect(aggregate.trend).toEqual([
      { weekStart: '2026-01-05', errors: 4 },
      { weekStart: '2026-01-12', errors: 1 },
      { weekStart: '2026-01-19', errors: 3 },
      { weekStart: '2026-01-26', errors: 0 },
    ]);
  });

  it('laesst leere Wochen vor dem ersten Fehler weg', () => {
    // Ein Befund aus dem Live-Lauf: Die Reihe 0-3-2-3-1 wurde als "worsening"
    // gemeldet, obwohl die letzte Woche die beste war - die fuehrende
    // Null-Woche zog den Vergleich der ersten Haelfte nach unten. Leere Wochen
    // **vor** dem ersten Fehler heissen nicht "damals lief es besser", sondern
    // "damals war noch nichts".
    const aggregate = aggregateErrors({
      errors: [err('a', 7), err('a', 8, { eventId: 'b' }), err('a', 14, { eventId: 'c' })],
      successes: [],
      // Zwei Wochen Vorlauf ohne einen einzigen Fehler.
      periodStart: at(-14),
      periodEnd: at(20),
    });

    expect(aggregate.trend[0]?.weekStart).toBe('2026-01-12');
    expect(aggregate.trend.every((point, index) => index > 0 || point.errors > 0)).toBe(true);
  });

  it('behaelt leere Wochen innerhalb der Reihe', () => {
    // Eine Luecke **zwischen** Fehlern ist eine Auskunft und bleibt stehen.
    const aggregate = aggregateErrors({
      errors: [err('a', 0), err('a', 14, { eventId: 'b' })],
      successes: [],
      periodStart: at(0),
      periodEnd: at(20),
    });

    expect(aggregate.trend).toEqual([
      { weekStart: '2026-01-05', errors: 1 },
      { weekStart: '2026-01-12', errors: 0 },
      { weekStart: '2026-01-19', errors: 1 },
    ]);
  });

  it('erkennt die Richtung der Entwicklung', () => {
    const woche = (weekStart: string, errors: number) => ({ weekStart, errors });

    expect(trendDirection([woche('a', 6), woche('b', 5), woche('c', 2), woche('d', 1)])).toBe(
      'improving',
    );
    expect(trendDirection([woche('a', 1), woche('b', 2), woche('c', 5), woche('d', 6)])).toBe(
      'worsening',
    );
    expect(trendDirection([woche('a', 3), woche('b', 3), woche('c', 3), woche('d', 3)])).toBe(
      'stable',
    );
    expect(trendDirection([woche('a', 3)])).toBe('unknown');
  });

  it('legt den Wochenanfang auf Montag in UTC', () => {
    expect(startOfUtcWeek(new Date('2026-01-08T23:00:00.000Z')).toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    );
    // Sonntag gehoert noch zur Vorwoche.
    expect(startOfUtcWeek(new Date('2026-01-11T12:00:00.000Z')).toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    );
  });

  it('ist deterministisch - gleiche Eingabe, gleiches Ergebnis', () => {
    const { errors, successes } = history();
    const input = { errors, successes, periodStart: at(0), periodEnd: at(27) };

    const einmal = aggregateErrors(input);
    // Umgedrehte Eingabereihenfolge: Die Sortierung muss sie egalisieren.
    const nochmal = aggregateErrors({
      ...input,
      errors: [...errors].reverse(),
      successes: [...successes].reverse(),
    });

    expect(nochmal).toEqual(einmal);
    expect(aggregateDigest(nochmal)).toBe(aggregateDigest(einmal));
  });

  it('aendert die Pruefsumme, sobald ein Fehler dazukommt', () => {
    const { errors, successes } = history();
    const input = { errors, successes, periodStart: at(-1), periodEnd: at(27) };

    const vorher = aggregateDigest(aggregateErrors(input));
    const nachher = aggregateDigest(
      aggregateErrors({ ...input, errors: [...errors, err('sb', 24, { eventId: 'neu' })] }),
    );

    expect(nachher).not.toBe(vorher);
  });

  it('haengt die Pruefsumme nicht am Zeitfenster', () => {
    // Ein Report am Folgetag mit unveraenderter Fehlerlage soll als "nichts
    // Neues" erkannt werden, obwohl sich der Zeitraum verschoben hat.
    const { errors, successes } = history();

    expect(
      aggregateDigest(
        aggregateErrors({ errors, successes, periodStart: at(0), periodEnd: at(27) }),
      ),
    ).toBe(
      aggregateDigest(
        aggregateErrors({ errors, successes, periodStart: at(0), periodEnd: at(28) }),
      ),
    );
  });
});

describe('Prompt-Darstellung (AP4.T4.6)', () => {
  it('enthaelt nur Zaehlstaende, keine Rohprotokolle', () => {
    const rendered = renderAggregate(
      aggregateErrors({
        errors: [
          err('sb', 0, { conceptTitle: 'Small-Blind-Verteidigung', severity: 'high' }),
          err('cbet', 2, { conceptTitle: 'C-Bet-Frequenz', topicArea: 'flop-spiel' }),
        ],
        successes: [],
        periodStart: at(-1),
        periodEnd: at(13),
      }),
    );

    expect(rendered).toContain('Small-Blind-Verteidigung | Preflop-Verteidigung | 1 | 1 | 0 |');
    expect(rendered).toContain('Fehler je Kontext');
    // Kein Beschreibungstext, keine Ereignis-IDs, keine Antworttexte.
    expect(rendered).not.toContain('falsch beantwortet');
    expect(rendered).not.toContain('sb-0-');
  });
});

describe('Muster-Kurzkennung (AP4.T4.6)', () => {
  it('leitet eine lesbare Kennung aus dem Titel ab', () => {
    // `sb-verteidigung-zu-weit` ist in einer Datenbankabfrage lesbar,
    // `muster-3` nicht.
    expect(patternTag('SB-Verteidigung zu weit')).toBe('sb-verteidigung-zu-weit');
    expect(patternTag('Übermäßige C-Bets im Turn')).toBe('uebermaessige-c-bets-im-turn');
  });

  it('faellt bei einem leeren Titel auf "muster" zurueck', () => {
    expect(patternTag('   ')).toBe('muster');
    expect(patternTag('!!!')).toBe('muster');
  });

  const contexts: LearningEventSource[] = ['drill', 'theory_session', 'hand_analysis'];
  it('deckt die Kontexte ab, die AP5, AP7 und AP8 erzeugen', () => {
    const aggregate = aggregateErrors({
      errors: contexts.map((contextKind, index) => err(`c${index}`, index, { contextKind })),
      successes: [],
      periodStart: at(-1),
      periodEnd: at(7),
    });
    expect(aggregate.byContext.map((entry) => entry.contextKind).sort()).toEqual(
      [...contexts].sort(),
    );
  });
});
