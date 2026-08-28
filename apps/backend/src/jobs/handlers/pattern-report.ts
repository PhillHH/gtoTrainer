import { PATTERN_CONFIDENCES, PATTERN_REPORT_JOB, PATTERN_REPORT_PERIOD_DAYS } from '@gto/shared';
import type { ErrorPattern } from '@gto/shared';
import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { LlmSettingsReader } from '../../llm/settings.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { aggregateDigest, renderAggregate } from '../../learning/patterns.js';
import {
  checkMinimum,
  collectErrorAggregate,
  ensureWeeklyReport,
  lastReportDigest,
  reportPeriod,
  storeReport,
} from '../../learning/report.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Muster-Report (AP4.T4.6) - **der einzige KI-Aufruf in AP4**.
 *
 * Der Ablauf ist bewusst so geschnitten, dass der Aufruf die **letzte** Stufe
 * ist und die drei davor ihn verhindern koennen:
 *
 * 1. **Aggregieren** - deterministischer Code verdichtet das Fehlerprotokoll zu
 *    Kennzahlen. Die Auswertung sieht nie ein Rohprotokoll.
 * 2. **Mindestdatenmenge pruefen** - unterhalb der Marke wird kein Aufruf
 *    abgesetzt, sondern ein Hinweis gespeichert.
 * 3. **Pruefsumme vergleichen** - hat sich seit dem letzten Report nichts
 *    geaendert, gibt es keinen zweiten Aufruf fuer dasselbe Ergebnis.
 * 4. **Aufrufen, pruefen, speichern** - und die Muster den Fehlereintraegen
 *    zuordnen.
 *
 * Kontingent: Ein kleiner Aufruf auf wenigen Kilobyte, kein Massenlauf. Er
 * teilt sich das Kontingent trotzdem mit dem Chart-Massenlauf aus AP3; bei
 * `rate_limit` legt der Worker den Job wieder vor. Das ist der eingeplante
 * Fall, kein Fehler.
 *
 * Was der Report **nicht** tut: einen Lernstand veraendern. Mastery, Queue,
 * Ratings und Level bleiben deterministisch berechnet (T4.3 bis T4.5) - der
 * Report deutet nur, was ohnehin in den Zahlen steht.
 */

export interface PatternReportPayload {
  /** Laenge des Zeitraums in Tagen. */
  readonly periodDays: number;
  /** Auch bei unveraenderter Datenlage neu auswerten. */
  readonly force: boolean;
  /** Bezugszeitpunkt; fehlt er, gilt der Zeitpunkt der Ausfuehrung. */
  readonly asOf?: string;
}

export interface PatternReportOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  readonly defaultModel: string;
  /**
   * Antwortgrenze. Drei bis fuenf Muster mit je vier Textfeldern bleiben klein;
   * grosszuegig gewaehlt, weil Modelle mit innerem Ueberlegen deutlich mehr
   * Tokens erzeugen, als die reine Antwort vermuten laesst.
   */
  readonly maxTokens?: number;
  readonly settings?: LlmSettingsReader;
  /** Nur fuer Tests: fester Bezugszeitpunkt. */
  readonly now?: () => Date;
}

const DEFAULT_MAX_TOKENS = 8192;

export function createPatternReportJob(
  options: PatternReportOptions,
): JobType<PatternReportPayload> {
  return {
    type: PATTERN_REPORT_JOB,

    parsePayload(raw: unknown): PatternReportPayload {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new JobPayloadError('Die Nutzlast muss ein Objekt sein.');
      }
      const candidate = raw as Record<string, unknown>;

      const periodDays = candidate['periodDays'] ?? PATTERN_REPORT_PERIOD_DAYS;
      if (!Number.isInteger(periodDays) || (periodDays as number) < 1) {
        throw new JobPayloadError('Feld "periodDays" muss eine positive Ganzzahl sein.');
      }
      const force = candidate['force'] ?? false;
      if (typeof force !== 'boolean') {
        throw new JobPayloadError('Feld "force" muss true oder false sein.');
      }
      const asOf = candidate['asOf'];
      if (asOf !== undefined && (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf)))) {
        throw new JobPayloadError('Feld "asOf" muss ein ISO-Zeitstempel sein.');
      }

      return {
        periodDays: periodDays as number,
        force,
        ...(typeof asOf === 'string' ? { asOf } : {}),
      };
    },

    async run(payload, context): Promise<void> {
      const asOf =
        payload.asOf === undefined ? (options.now?.() ?? new Date()) : new Date(payload.asOf);
      const period = reportPeriod(asOf, payload.periodDays);

      // Stufe 1: aggregieren.
      const aggregate = await collectErrorAggregate(context.db, period);

      // Stufe 2: Mindestdatenmenge.
      const skip = checkMinimum(aggregate);
      if (skip !== null) {
        await storeReport(context.db, { period, aggregate, generatedAt: asOf, note: skip.note });
        await ensureWeeklyReport(context.db, asOf);
        context.log(`Muster-Report uebersprungen: ${skip.note}`);
        return;
      }

      // Stufe 3: Pruefsumme. Unveraenderte Datenlage heisst unveraendertes
      // Ergebnis - ein zweiter Aufruf kostet Kontingent und liefert nichts.
      const digest = aggregateDigest(aggregate);
      if (!payload.force && digest === (await lastReportDigest(context.db))) {
        await ensureWeeklyReport(context.db, asOf);
        context.log(
          'Muster-Report uebersprungen: Seit dem letzten Report hat sich an der Fehlerlage ' +
            'nichts geaendert. Mit force=true erzwingen.',
        );
        return;
      }

      // Stufe 4: der Aufruf.
      const settings = await options.settings?.read();
      const timeoutMs = settings?.timeoutMs;

      const request = options.templates.renderRequest(
        'task/error-patterns',
        {
          kennzahlen: renderAggregate(aggregate),
          zeitraum: `${period.start.toISOString().slice(0, 10)} bis ${period.end
            .toISOString()
            .slice(0, 10)}`,
        },
        {
          model: settings?.model ?? options.defaultModel,
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      );

      const provider = await options.providers.getActive();
      const response = await provider.complete(request);

      const parsed = readPatterns(response.json ?? response.text);

      const view = await storeReport(context.db, {
        period,
        aggregate,
        generatedAt: asOf,
        patterns: parsed.muster,
        note: parsed.hinweis === '' ? undefined : parsed.hinweis,
        model: response.meta.model,
        provider: response.meta.provider,
        durationMs: response.meta.durationMs,
      });

      // Der naechste turnusmaessige Lauf - ohne eigenen Scheduler.
      await ensureWeeklyReport(context.db, asOf);

      context.log(
        `Muster-Report: ${view.patterns.length} Muster aus ${aggregate.totalErrors} Fehlern ` +
          `ueber ${aggregate.totalConcepts} Konzepte, ` +
          `${view.patterns.reduce((sum, pattern) => sum + pattern.taggedErrors, 0)} Eintraege markiert ` +
          `(${response.meta.provider}/${response.meta.model}, ${response.meta.durationMs} ms).`,
      );
    },
  };
}

/**
 * Liest die Muster aus der Antwort.
 *
 * Ein Schema-Verstoss ist ein `JobPayloadError` - **kein leerer Report**. Einen
 * leeren Report zu speichern waere die schlimmere Variante: Er saehe aus wie
 * "keine Muster gefunden", waere aber "die Antwort war unbrauchbar". Der
 * Unterschied ist fuer den Nutzer entscheidend und im Nachhinein nicht mehr
 * erkennbar.
 */
export function readPatterns(source: unknown): {
  muster: ErrorPattern[];
  hinweis: string;
} {
  let value = source;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new JobPayloadError('Die Antwort war kein JSON.');
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JobPayloadError('Die Antwort war kein Objekt.');
  }

  const candidate = value as Record<string, unknown>;
  const list = candidate['muster'];
  if (!Array.isArray(list)) {
    throw new JobPayloadError('Feld "muster" fehlt oder ist keine Liste.');
  }
  const hinweis = candidate['hinweis'];
  if (typeof hinweis !== 'string') {
    throw new JobPayloadError('Feld "hinweis" fehlt oder ist keine Zeichenkette.');
  }

  return { muster: list.map(readPattern), hinweis };
}

function readPattern(raw: unknown, index: number): ErrorPattern {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new JobPayloadError(`Muster ${index + 1} ist kein Objekt.`);
  }
  const entry = raw as Record<string, unknown>;

  const text = (field: string): string => {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new JobPayloadError(`Muster ${index + 1}: Feld "${field}" fehlt oder ist leer.`);
    }
    return value;
  };
  const list = (field: string): string[] => {
    const value = entry[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new JobPayloadError(`Muster ${index + 1}: Feld "${field}" muss eine Textliste sein.`);
    }
    return value as string[];
  };

  const anzahl = entry['anzahl'];
  if (!Number.isInteger(anzahl) || (anzahl as number) < 1) {
    throw new JobPayloadError(`Muster ${index + 1}: Feld "anzahl" muss eine Ganzzahl ab 1 sein.`);
  }
  const vertrauen = entry['vertrauen'];
  if (
    typeof vertrauen !== 'string' ||
    !(PATTERN_CONFIDENCES as readonly string[]).includes(vertrauen)
  ) {
    throw new JobPayloadError(
      `Muster ${index + 1}: Feld "vertrauen" muss ${PATTERN_CONFIDENCES.join(', ')} sein.`,
    );
  }

  return {
    titel: text('titel'),
    beobachtung: text('beobachtung'),
    deutung: text('deutung'),
    empfehlung: text('empfehlung'),
    konzepte: list('konzepte'),
    themenbereiche: list('themenbereiche'),
    anzahl: anzahl as number,
    zeitraum: text('zeitraum'),
    vertrauen: vertrauen as ErrorPattern['vertrauen'],
  };
}
