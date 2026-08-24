import { eq, sql } from 'drizzle-orm';
import { CHART_TOLERANCES } from '@gto/shared';
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { chartRecheck, jobQueue } from '../db/schema.js';
import { CHART_RECHECK_JOB } from '../jobs/handlers/chart-recheck.js';
import { enqueueJob } from '../jobs/queue.js';
import {
  approveAllValidated,
  chartsToValidate,
  chartsWithErrors,
  validateAndStore,
  validationProgress,
} from './validation-store.js';

/**
 * Steuerung der Chart-Validierung (AP3.T3.4).
 *
 *   pnpm charts:validate                 # alle raw/validated Charts pruefen
 *   pnpm charts:validate --status        # Zaehlstaende und Befunde
 *   pnpm charts:validate --recheck [n]   # Zweitdurchlauf fuer beanstandete
 *   pnpm charts:validate --approve       # alle validated freigeben
 *   pnpm charts:validate --no-monotonie  # einzelne Heuristik abschalten
 *
 * Die Pruefungen selbst sind deterministischer Code und kosten kein
 * Kontingent. Nur `--recheck` plant Vision-Aufrufe ein - und ausschliesslich
 * fuer Charts mit Fehlerbefund.
 */

interface Args {
  status: boolean;
  approve: boolean;
  recheck?: number;
  limit?: number;
  checks: {
    frequencySum: boolean;
    captionMatch: boolean;
    completeness: boolean;
    monotonicity: boolean;
    outlier: boolean;
  };
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    status: false,
    approve: false,
    checks: {
      frequencySum: true,
      captionMatch: true,
      completeness: true,
      monotonicity: true,
      outlier: true,
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--status') args.status = true;
    else if (flag === '--approve') args.approve = true;
    else if (flag === '--recheck') {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        args.recheck = Number(next);
        i += 1;
      } else args.recheck = Number.POSITIVE_INFINITY;
    } else if (flag === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit erwartet eine Ganzzahl.');
      args.limit = value;
    } else if (flag === '--no-summe') args.checks.frequencySum = false;
    else if (flag === '--no-caption') args.checks.captionMatch = false;
    else if (flag === '--no-vollstaendigkeit') args.checks.completeness = false;
    else if (flag === '--no-monotonie') args.checks.monotonicity = false;
    else if (flag === '--no-ausreisser') args.checks.outlier = false;
    else {
      throw new Error(
        `Unbekanntes Argument: ${String(flag)}\n` +
          'Aufruf: pnpm charts:validate [--status] [--recheck [n]] [--approve] [--limit n]\n' +
          '        [--no-summe] [--no-caption] [--no-vollstaendigkeit] [--no-monotonie] [--no-ausreisser]',
      );
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = createDb(loadConfig().databaseUrl, { max: 2 });

  try {
    if (args.status) {
      await printStatus(handle.db);
      return;
    }

    if (args.approve) {
      const approved = await approveAllValidated(handle.db);
      console.warn(`${approved} Charts von "validated" auf "approved" gesetzt.`);
      await printStatus(handle.db);
      return;
    }

    if (args.recheck !== undefined) {
      const beanstandet = await chartsWithErrors(
        handle.db,
        Number.isFinite(args.recheck) ? args.recheck : undefined,
      );
      if (beanstandet.length === 0) {
        console.warn('Kein Chart mit Fehlerbefund - nichts nachzulesen.');
        return;
      }
      const runId = `recheck-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      for (const entry of beanstandet) {
        await enqueueJob(handle.db, {
          jobType: CHART_RECHECK_JOB,
          payload: { chartId: entry.chartId, runId },
        });
      }
      console.warn(
        `${beanstandet.length} beanstandete Charts fuer den Zweitdurchlauf eingeplant ` +
          `(${CHART_RECHECK_JOB}), Lauf "${runId}".`,
      );
      console.warn('Nur Beanstandetes - unauffaellige Charts kosten kein Kontingent.');
      return;
    }

    // Standardfall: alle raw/validated Charts pruefen.
    const ids = await chartsToValidate(
      handle.db,
      args.limit === undefined ? {} : { limit: args.limit },
    );
    console.warn(`Pruefe ${ids.length} Charts (deterministisch, ohne KI-Aufruf) …`);
    console.warn(
      `Toleranzen: Frequenzsumme ±${CHART_TOLERANCES.frequencySumPp} pp, ` +
        `Caption ±${CHART_TOLERANCES.captionMatchPp} pp, ` +
        `Monotonie ${CHART_TOLERANCES.monotonicityPp} pp, ` +
        `Ausreisser ${CHART_TOLERANCES.outlierPp} pp.`,
    );
    console.warn('');

    let passed = 0;
    let failed = 0;
    for (const id of ids) {
      const outcome = await validateAndStore(handle.db, id, args.checks);
      if (outcome === undefined) continue;
      if (outcome.passed) passed += 1;
      else {
        failed += 1;
        console.warn(
          `  HR ${outcome.captionNumber ?? '?'}: ${outcome.errors} Fehler, ` +
            `${outcome.warnings} Warnungen`,
        );
      }
    }

    console.warn('');
    console.warn(`Bestanden: ${passed} · beanstandet: ${failed}`);
    await printStatus(handle.db);
  } finally {
    await handle.close();
  }
}

async function printStatus(db: ReturnType<typeof createDb>['db']): Promise<void> {
  const progress = await validationProgress(db);

  console.warn('');
  console.warn('Zustand');
  for (const state of ['raw', 'validated', 'approved', 'failed', 'unusable']) {
    console.warn(`  ${state.padEnd(10)} ${progress.byState[state] ?? 0}`);
  }
  console.warn(
    `  ---        ${progress.digitized} digitalisiert von ${progress.handRangeAssets} hand_range-Assets`,
  );
  console.warn('');
  console.warn(
    `Approved-Quote: ${(progress.approvedShare * 100).toFixed(1)} % ` +
      `(${progress.byState['approved'] ?? 0} von ${progress.handRangeAssets}) — DoD-Schwelle 95 %`,
  );

  console.warn('');
  console.warn('Befunde je Pruefart (ohne Hinweise)');
  for (const check of ['frequency-sum', 'caption-match', 'plausibility']) {
    console.warn(`  ${check.padEnd(16)} ${progress.findingsByCheck[check] ?? 0}`);
  }
  console.warn('');
  console.warn('Befunde je Schweregrad');
  for (const [severity, count] of Object.entries(progress.findingsBySeverity)) {
    console.warn(`  ${severity.padEnd(10)} ${count}`);
  }

  const rechecks = await db
    .select({
      n: sql<number>`count(*)::int`,
      changed: sql<number>`coalesce(sum(${chartRecheck.cellsChanged}), 0)::int`,
      agreed: sql<number>`coalesce(sum(${chartRecheck.cellsAgreed}), 0)::int`,
    })
    .from(chartRecheck);
  console.warn('');
  console.warn(
    `Zweitdurchlaeufe: ${rechecks[0]?.n ?? 0} · ${rechecks[0]?.agreed ?? 0} Zellen bestaetigt, ` +
      `${rechecks[0]?.changed ?? 0} geaendert`,
  );

  const jobs = await db
    .select({ status: jobQueue.status, n: sql<number>`count(*)::int` })
    .from(jobQueue)
    .where(eq(jobQueue.jobType, CHART_RECHECK_JOB))
    .groupBy(jobQueue.status);
  if (jobs.length > 0) {
    console.warn('');
    console.warn('Recheck-Jobs');
    for (const row of jobs) console.warn(`  ${row.status.padEnd(10)} ${row.n}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    `[charts:validate] Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
