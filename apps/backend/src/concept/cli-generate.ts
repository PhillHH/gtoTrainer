import { asc, eq, sql } from 'drizzle-orm';
import { CONCEPT_TOPIC_AREAS, conceptTopicAreaLabel } from '@gto/shared';
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { bookChapter, concept, jobQueue } from '../db/schema.js';
import { CONCEPT_EXTRACT_JOB } from '../jobs/handlers/concept-extract.js';
import { enqueueJob } from '../jobs/queue.js';
import {
  assignChartsBySection,
  collectIssues,
  loadChapterSections,
  loadChapters,
  planChapterParts,
} from './store.js';

/**
 * Konzept-Generierung von der Kommandozeile (AP3.T3.2).
 *
 *   pnpm concepts:generate --plan     # zeigt nur, welche Jobs entstehen wuerden
 *   pnpm concepts:generate            # plant die Jobs ein (Worker arbeitet sie ab)
 *   pnpm concepts:generate --chapter 7
 *   pnpm concepts:generate --charts   # Chart-Zuordnung nachziehen (ohne KI)
 *   pnpm concepts:generate --report   # Zaehlstaende und Befunde ausgeben
 *
 * Eingeplant wird ein Job **je Kapitelteil**. Der Worker arbeitet sie einzeln
 * ab; ein fehlgeschlagenes Kapitel zieht die uebrigen nicht mit. Bei
 * `rate_limit` legt die Queue den Job automatisch wieder vor.
 */

interface Args {
  plan: boolean;
  charts: boolean;
  report: boolean;
  chapter?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { plan: false, charts: false, report: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--plan') args.plan = true;
    else if (flag === '--charts') args.charts = true;
    else if (flag === '--report') args.report = true;
    else if (flag === '--chapter') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--chapter erwartet eine positive Ganzzahl.');
      }
      args.chapter = value;
    } else {
      throw new Error(
        `Unbekanntes Argument: ${String(flag)}\n` +
          'Aufruf: pnpm concepts:generate [--plan] [--chapter <n>] [--charts] [--report]',
      );
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = createDb(loadConfig().databaseUrl, { max: 2 });

  try {
    if (args.report) {
      await printReport(handle.db);
      return;
    }

    if (args.charts) {
      const result = await assignChartsBySection(handle.db);
      console.warn(
        `Chart-Zuordnung: ${result.links} neue Verknuepfungen (Regel: gleiche Sektion).`,
      );
      return;
    }

    const chapters = await loadChapters(handle.db);
    if (chapters.length === 0) {
      throw new Error('Keine Kapitel in der Datenbank. Erst "pnpm book:import" ausfuehren.');
    }

    const wanted = args.chapter
      ? chapters.filter((chapter) => chapter.chapterNumber === args.chapter)
      : chapters;
    if (wanted.length === 0) {
      throw new Error(`Kapitel ${String(args.chapter)} gibt es nicht.`);
    }

    let jobs = 0;
    for (const chapter of wanted) {
      const sections = await loadChapterSections(handle.db, chapter.chapterNumber);
      const parts = planChapterParts(sections);
      const chars = sections.reduce((sum, section) => sum + section.body.length, 0);
      console.warn(
        `Kapitel ${String(chapter.chapterNumber).padStart(2, '0')}: ` +
          `${sections.length} Sektionen, ${chars} Zeichen -> ${parts.length} Teillauf/Teillaeufe`,
      );

      if (args.plan) {
        jobs += parts.length;
        continue;
      }
      for (let part = 1; part <= parts.length; part++) {
        await enqueueJob(handle.db, {
          jobType: CONCEPT_EXTRACT_JOB,
          payload: { chapterNumber: chapter.chapterNumber, part },
        });
        jobs += 1;
      }
    }

    console.warn('');
    console.warn(
      args.plan
        ? `Trockenlauf: ${jobs} Jobs wuerden eingeplant. Nichts geschrieben.`
        : `${jobs} Jobs eingeplant (${CONCEPT_EXTRACT_JOB}). Der Worker arbeitet sie nacheinander ab.`,
    );
    if (!args.plan) {
      console.warn('Fortschritt: pnpm concepts:generate --report');
    }
  } finally {
    await handle.close();
  }
}

/** Zaehlstaende und Befunde - die Grundlage der Abnahme. */
async function printReport(db: ReturnType<typeof createDb>['db']): Promise<void> {
  const perChapter = await db
    .select({
      chapterNumber: bookChapter.chapterNumber,
      title: bookChapter.title,
      total: sql<number>`count(${concept.id})::int`,
      approved: sql<number>`count(*) filter (where ${concept.state} = 'approved')::int`,
    })
    .from(bookChapter)
    .leftJoin(concept, eq(concept.chapterId, bookChapter.id))
    .groupBy(bookChapter.chapterNumber, bookChapter.title)
    .orderBy(asc(bookChapter.chapterNumber));

  const perTopic = await db
    .select({ topicArea: concept.topicArea, n: sql<number>`count(*)::int` })
    .from(concept)
    .groupBy(concept.topicArea);
  const topicCounts = new Map(perTopic.map((row) => [row.topicArea, row.n]));

  const pending = await db
    .select({ status: jobQueue.status, n: sql<number>`count(*)::int` })
    .from(jobQueue)
    .where(eq(jobQueue.jobType, CONCEPT_EXTRACT_JOB))
    .groupBy(jobQueue.status);

  const issues = await collectIssues(db);
  const total = perChapter.reduce((sum, row) => sum + row.total, 0);

  console.warn('Konzepte je Kapitel');
  for (const row of perChapter) {
    console.warn(
      `  ${String(row.chapterNumber).padStart(2, '0')}  ${String(row.total).padStart(3)} ` +
        `(${row.approved} approved)  ${row.title}`,
    );
  }
  console.warn(`  ---  ${String(total).padStart(3)} gesamt (Zielbereich 120-200)`);

  console.warn('');
  console.warn('Konzepte je Themenbereich');
  for (const area of CONCEPT_TOPIC_AREAS) {
    console.warn(
      `  ${String(topicCounts.get(area.id) ?? 0).padStart(3)}  ${conceptTopicAreaLabel(area.id)}`,
    );
  }

  console.warn('');
  console.warn('Jobs');
  if (pending.length === 0) console.warn('  keine');
  for (const row of pending) console.warn(`  ${row.status}: ${row.n}`);

  console.warn('');
  console.warn('Befunde');
  console.warn(`  Zyklen:                       ${issues.cycles.length}`);
  console.warn(`  offene Voraussetzungen:       ${issues.unresolved.length} Konzepte`);
  console.warn(`  ohne Sektionszuordnung:       ${issues.withoutSection.length}`);
  console.warn(
    `  Kapitel ohne Konzepte:        ${issues.emptyChapters.length}` +
      (issues.emptyChapters.length > 0 ? ` (${issues.emptyChapters.join(', ')})` : ''),
  );
}

main().catch((error: unknown) => {
  console.error(
    `[concepts:generate] Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
