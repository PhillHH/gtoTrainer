import { and, eq, sql } from 'drizzle-orm';
import { CHART_HAND_COUNT } from '@gto/shared';
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { jobQueue, rangeChart } from '../db/schema.js';
import { CHART_DIGITIZE_JOB } from '../jobs/handlers/chart-digitize.js';
import { enqueueJob } from '../jobs/queue.js';
import { chartProgress, selectCandidates, uncertainHandRangeAssets } from './store.js';

/**
 * Steuerung der Chart-Digitalisierung (AP3.T3.3, Subtask 6).
 *
 *   pnpm charts:digitize --dry-run              # zeigt Umfang und Kosten, ruft nichts auf
 *   pnpm charts:digitize --limit 10             # erste Charge
 *   pnpm charts:digitize --chapter 7
 *   pnpm charts:digitize --asset <uuid> [...]
 *   pnpm charts:digitize --model claude-sonnet-5
 *   pnpm charts:digitize --redo                 # auch schon digitalisierte erneut
 *   pnpm charts:digitize --status               # Fortschritt
 *
 * **Wiederaufnahme ist der Normalfall:** Ohne `--redo` werden bereits
 * digitalisierte Charts gar nicht erst eingeplant. Ein durch ein Session- oder
 * Wochenlimit gestoppter Lauf setzt damit fort, wo er aufhoerte.
 */

interface Args {
  dryRun: boolean;
  status: boolean;
  redo: boolean;
  limit?: number;
  chapter?: number;
  model?: string;
  assets: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, status: false, redo: false, assets: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--status') args.status = true;
    else if (flag === '--redo') args.redo = true;
    else if (flag === '--limit') args.limit = positive(argv[++i], '--limit');
    else if (flag === '--chapter') args.chapter = positive(argv[++i], '--chapter');
    else if (flag === '--model') args.model = required(argv[++i], '--model');
    else if (flag === '--asset') args.assets.push(required(argv[++i], '--asset'));
    else {
      throw new Error(
        `Unbekanntes Argument: ${String(flag)}\n` +
          'Aufruf: pnpm charts:digitize [--dry-run] [--status] [--redo] ' +
          '[--limit <n>] [--chapter <n>] [--asset <uuid>] [--model <id>]',
      );
    }
  }
  return args;
}

function positive(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} erwartet eine positive Ganzzahl.`);
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${flag} erwartet einen Wert.`);
  return value.trim();
}

/**
 * Kostenschaetzung je Chart.
 *
 * Die Zahlen stammen aus dem Kalibrierungslauf (ADR-0033) und sind bewusst
 * grob: Sie sollen vor einem Lauf die Groessenordnung zeigen, nicht abrechnen.
 */
const TOKENS_PER_CHART = 12_000;
const SECONDS_PER_CHART = 90;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = createDb(loadConfig().databaseUrl, { max: 2 });

  try {
    if (args.status) {
      await printStatus(handle.db);
      return;
    }

    const candidates = await selectCandidates(handle.db, {
      ...(args.chapter === undefined ? {} : { chapterNumber: args.chapter }),
      ...(args.assets.length === 0 ? {} : { assetIds: args.assets }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      includeDone: args.redo,
    });

    const uncertain = await uncertainHandRangeAssets(handle.db);
    const progress = await chartProgress(handle.db);

    console.warn(`hand_range-Assets gesamt:      ${progress.handRangeTotal}`);
    console.warn(`davon bereits digitalisiert:   ${progress.handRangeTotal - progress.remaining}`);
    console.warn(`unsicher klassifiziert (uebersprungen): ${uncertain.length}`);
    console.warn(`in diesem Lauf:                ${candidates.length}`);
    console.warn('');
    console.warn(
      `Schaetzung: ~${(candidates.length * TOKENS_PER_CHART).toLocaleString('de-DE')} Tokens, ` +
        `~${Math.round((candidates.length * SECONDS_PER_CHART) / 60)} Minuten bei einem Aufruf ` +
        'nach dem anderen.',
    );

    if (args.dryRun) {
      console.warn('');
      console.warn('Trockenlauf - es wurde kein Aufruf abgesetzt und nichts eingeplant.');
      for (const candidate of candidates.slice(0, 10)) {
        console.warn(
          `  ${candidate.fileName}  ${candidate.captionNumber === null ? '' : `HR ${candidate.captionNumber}`}`,
        );
      }
      if (candidates.length > 10) console.warn(`  … und ${candidates.length - 10} weitere`);
      return;
    }

    if (candidates.length === 0) {
      console.warn('');
      console.warn(
        'Nichts zu tun. Mit --redo laesst sich ein bereits digitalisierter Chart erneut lesen.',
      );
      return;
    }

    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const candidate of candidates) {
      await enqueueJob(handle.db, {
        jobType: CHART_DIGITIZE_JOB,
        payload: {
          assetId: candidate.assetId,
          runId,
          ...(args.model === undefined ? {} : { model: args.model }),
        },
      });
    }

    console.warn('');
    console.warn(`${candidates.length} Jobs eingeplant (${CHART_DIGITIZE_JOB}), Lauf "${runId}".`);
    console.warn('Fortschritt: pnpm charts:digitize --status');
  } finally {
    await handle.close();
  }
}

async function printStatus(db: ReturnType<typeof createDb>['db']): Promise<void> {
  const progress = await chartProgress(db);

  console.warn('Charts');
  console.warn(`  hand_range-Assets (sicher):  ${progress.handRangeTotal}`);
  console.warn(`  unsicher, uebersprungen:     ${progress.uncertainSkipped}`);
  console.warn(`  offen:                       ${progress.remaining}`);
  console.warn('');
  console.warn('Zustand');
  for (const [state, count] of Object.entries(progress.byState)) {
    console.warn(`  ${state.padEnd(10)} ${count}`);
  }
  if (Object.keys(progress.byState).length === 0) console.warn('  (noch keine)');
  console.warn('');
  console.warn('Vollstaendigkeit der Matrizen');
  console.warn(`  ${CHART_HAND_COUNT} Zellen (vollstaendig): ${progress.complete}`);
  console.warn(`  unvollstaendig:             ${progress.incomplete}`);
  console.warn(`  kein Aktionsraster im Bild: ${progress.noGrid}`);
  console.warn('');
  console.warn('Modelle');
  for (const [model, count] of Object.entries(progress.byModel)) {
    console.warn(`  ${model.padEnd(24)} ${count}`);
  }
  if (Object.keys(progress.byModel).length === 0) console.warn('  (noch keine)');

  const jobs = await db
    .select({ status: jobQueue.status, n: sql<number>`count(*)::int` })
    .from(jobQueue)
    .where(eq(jobQueue.jobType, CHART_DIGITIZE_JOB))
    .groupBy(jobQueue.status);
  console.warn('');
  console.warn('Jobs');
  if (jobs.length === 0) console.warn('  keine');
  for (const row of jobs) console.warn(`  ${row.status.padEnd(10)} ${row.n}`);

  const tokens = await db
    .select({
      total: sql<number>`coalesce(sum(${rangeChart.totalTokens}), 0)::int`,
      duration: sql<number>`coalesce(sum(${rangeChart.durationMs}), 0)::bigint`,
    })
    .from(rangeChart)
    .where(and(sql`${rangeChart.totalTokens} is not null`));
  console.warn('');
  console.warn(
    `Verbrauch: ${Number(tokens[0]?.total ?? 0).toLocaleString('de-DE')} Tokens, ` +
      `${Math.round(Number(tokens[0]?.duration ?? 0) / 60000)} Minuten Modellzeit.`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `[charts:digitize] Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
