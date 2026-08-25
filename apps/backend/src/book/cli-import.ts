import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findRepoRoot, loadConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { analyzeBook, importBook } from './import.js';
import { buildReport, formatReport, formatSummary } from './report.js';
import { BookSourceError } from './source.js';

/**
 * Buchimport von der Kommandozeile (AP3.T3.1, Subtask 8).
 *
 *   pnpm book:import                # importiert und schreibt den Report
 *   pnpm book:import --dry-run      # analysiert nur, schreibt nichts in die DB
 *   pnpm book:import --source <dir> # abweichendes Quellverzeichnis
 *   pnpm book:import --out <datei>  # abweichender Reportpfad
 *
 * Der Report enthaelt Kapitel- und Sektionstitel aus dem Buch und landet
 * deshalb unter `data/reports/` - git-ignoriert, wie die Buchquellen selbst.
 */

/** Standardpfad des Reports, relativ zur Repo-Wurzel. */
export const DEFAULT_REPORT_PATH = 'data/reports/book-import.md';

interface Args {
  dryRun: boolean;
  sourceDir?: string;
  out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--source') args.sourceDir = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else
      throw new Error(
        `Unbekanntes Argument: ${flag}\nAufruf: pnpm book:import [--dry-run] [--source <dir>] [--out <datei>]`,
      );
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = resolve(
    args.out ?? resolve(findRepoRoot(), ...DEFAULT_REPORT_PATH.split('/')),
  );

  const options = args.sourceDir ? { sourceDir: args.sourceDir } : {};

  // Der Trockenlauf kommt ohne Datenbank aus - genau das macht ihn als
  // Vorabpruefung brauchbar, bevor Postgres ueberhaupt laeuft.
  const handle = args.dryRun ? undefined : createDb(loadConfig().databaseUrl, { max: 1 });

  try {
    const result = handle ? await importBook(handle.db, options) : analyzeBook(options);

    const report = buildReport(result);
    const markdown = formatReport(report, new Date().toISOString());

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${markdown}\n`, 'utf8');

    console.warn(formatSummary(report));
    console.warn('');
    console.warn(`Report geschrieben: ${reportPath}`);
    if (report.dryRun) console.warn('Trockenlauf - es wurde nichts in die Datenbank geschrieben.');
  } finally {
    await handle?.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BookSourceError) {
    console.error(`[book:import] Abbruch - Vorbedingung nicht erfüllt.\n${error.message}`);
  } else {
    console.error(
      `[book:import] Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exit(1);
});
