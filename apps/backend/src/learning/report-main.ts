import { PATTERN_REPORT_JOB, PATTERN_REPORT_PERIOD_DAYS } from '@gto/shared';
import { createDb } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { redact } from '../db/migrate.js';
import { enqueueJob } from '../jobs/queue.js';
import { readLatestReport, readReportHistory } from './report.js';

/**
 * CLI-Einstieg: `pnpm learning:report [--run] [--force] [--days <n>] [--history]`.
 *
 * Ohne Argumente zeigt es den juengsten Report. `--run` plant einen neuen ein -
 * ausgefuehrt wird er vom Job-Worker, nicht von diesem Skript. So laeuft der
 * einzige KI-Aufruf in AP4 ueber dieselbe Queue wie alles andere: mit Retry,
 * Protokoll und Dead-Letter.
 */
export interface ReportArgs {
  readonly run: boolean;
  readonly force: boolean;
  readonly days: number;
  readonly history: boolean;
}

export function parseArgs(argv: readonly string[]): ReportArgs {
  let run = false;
  let force = false;
  let history = false;
  let days = PATTERN_REPORT_PERIOD_DAYS;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--run') run = true;
    else if (token === '--force') {
      force = true;
      run = true;
    } else if (token === '--history') history = true;
    else if (token === '--days') {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--days braucht eine positive Ganzzahl, bekam "${String(raw)}".`);
      }
      days = value;
      i += 1;
    } else {
      throw new Error(
        `Unbekanntes Argument "${String(token)}". Erlaubt: --run, --force, --days <n>, --history.`,
      );
    }
  }

  return { run, force, days, history };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });

  try {
    if (args.run) {
      const job = await enqueueJob(handle.db, {
        jobType: PATTERN_REPORT_JOB,
        payload: { periodDays: args.days, force: args.force },
      });
      console.error(
        `[learning:report] ${redact(databaseUrl)} - Job ${job.id} eingeplant ` +
          `(${args.days} Tage${args.force ? ', erzwungen' : ''}). ` +
          `Der Worker fuehrt ihn aus; Fortschritt in den letzten KI-Aufrufen.`,
      );
      return;
    }

    if (args.history) {
      const history = await readReportHistory(handle.db);
      if (history.length === 0) {
        console.error('[learning:report] Noch kein Report vorhanden.');
        return;
      }
      for (const report of history) {
        console.error(
          `- ${report.generatedAt} | ${report.status} | ${report.patterns.length} Muster | ` +
            `${report.errorCount} Fehler / ${report.conceptCount} Konzepte | ${report.model ?? '(kein Aufruf)'}`,
        );
      }
      return;
    }

    const report = await readLatestReport(handle.db);
    if (report === null) {
      console.error('[learning:report] Noch kein Report vorhanden. Mit --run einen einplanen.');
      return;
    }

    console.error(
      `[learning:report] ${report.generatedAt} | ${report.status} | ` +
        `Zeitraum ${report.periodStart.slice(0, 10)} bis ${report.periodEnd.slice(0, 10)} | ` +
        `${report.errorCount} Fehler ueber ${report.conceptCount} Konzepte` +
        (report.model === null
          ? ''
          : ` | ${report.provider}/${report.model}, ${report.durationMs} ms`),
    );
    if (report.note !== null && report.note !== '') {
      console.error(`[learning:report] Hinweis: ${report.note}`);
    }
    for (const pattern of report.patterns) {
      console.error(
        `\n### ${pattern.titel}  [${pattern.tag}]  (${pattern.vertrauen}, ${pattern.anzahl} Beobachtungen, ${pattern.taggedErrors} markiert)\n` +
          `  Beobachtung: ${pattern.beobachtung}\n` +
          `  Deutung:     ${pattern.deutung}\n` +
          `  Empfehlung:  ${pattern.empfehlung}\n` +
          `  Konzepte:    ${pattern.konzepte.join(', ')}`,
      );
    }
  } finally {
    await handle.close();
  }
}
