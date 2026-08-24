import { eq, sql } from 'drizzle-orm';
import { CHART_HANDS } from '@gto/shared';
import type { Database } from '../../src/db/client.js';
import {
  bookAsset,
  bookChapter,
  bookSection,
  concept,
  conceptChart,
  conceptPrerequisite,
  conceptSection,
  rangeChart,
  rangeChartCell,
} from '../../src/db/schema.js';
import { importBook } from '../../src/book/import.js';
import { MINI_BOOK } from '../book/fixtures.js';

/**
 * Aufbau der Testdaten fuer die Content-API (AP3.T3.5).
 *
 * Das Buch wird ueber den **echten** Importpfad aus T3.1 eingelesen
 * (`importBook` gegen die Mini-Book-Fixture) - die Content-Tests laufen damit
 * gegen Daten, die den Produktionsweg genommen haben, nicht gegen von Hand
 * gesetzte Zeilen. Konzepte und Charts kommen von Hand dazu, weil ihre
 * Erzeugung einen KI-Aufruf braeuchte und dieser Task keinen absetzt.
 */

export async function clearAll(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table chart_finding, chart_recheck, range_chart_cell, range_chart,
        concept_chart, concept_section, concept_prerequisite, concept,
        book_asset, book_section, book_chapter, job_queue, llm_call_log cascade`,
  );
}

export interface SeededContent {
  readonly chapterIds: Record<number, string>;
  readonly sectionIds: Record<string, string>;
  readonly assetIds: Record<string, string>;
  readonly conceptIds: Record<string, string>;
  /** Freigegebenes Chart: BN vs BB, 25bb, Raise 2.2x. */
  readonly approvedChartId: string;
  /** Chart im Zustand `raw` - darf nach aussen nicht sichtbar sein. */
  readonly rawChartId: string;
}

async function insertChart(
  db: Database,
  options: {
    assetId: string;
    state: string;
    spot: Record<string, unknown>;
    actions: { kind: string; sizing: string | null }[];
    aggressive: (hand: string) => boolean;
    aggressiveKind: string;
    manualHands?: readonly string[];
  },
): Promise<string> {
  const [row] = await db
    .insert(rangeChart)
    .values({
      assetId: options.assetId,
      state: options.state,
      model: 'claude-sonnet-5',
      runId: 'run-content-test',
      actions: options.actions,
      spot: options.spot,
      uncertain: [],
      cellCount: CHART_HANDS.length,
      ...(options.state === 'approved' ? { approvedAt: new Date() } : {}),
    })
    .returning({ id: rangeChart.id });
  const chartId = (row as { id: string }).id;

  const manual = new Set(options.manualHands ?? []);
  await db.insert(rangeChartCell).values(
    CHART_HANDS.map((hand) => ({
      chartId,
      hand,
      actionKind: options.aggressive(hand) ? options.aggressiveKind : 'fold',
      sizing: options.aggressive(hand) ? (options.actions[0]?.sizing ?? '') : '',
      percent: 100,
      ...(manual.has(hand) ? { source: 'manual' as const, correctedAt: new Date() } : {}),
    })),
  );
  return chartId;
}

/** Baut den vollstaendigen Testbestand auf. */
export async function seedContent(db: Database): Promise<SeededContent> {
  await importBook(db, { sourceDir: MINI_BOOK });

  const chapters = await db.select().from(bookChapter);
  const chapterIds = Object.fromEntries(
    chapters.map((row) => [row.chapterNumber, row.id]),
  ) as Record<number, string>;

  const sections = await db.select().from(bookSection);
  const sectionIds = Object.fromEntries(sections.map((row) => [row.sectionKey, row.id]));

  const assets = await db.select().from(bookAsset);
  const assetIds = Object.fromEntries(assets.map((row) => [row.fileName, row.id]));

  const conceptIds: Record<string, string> = {};
  const conceptRows = [
    {
      slug: 'pot-odds',
      title: 'Pot Odds',
      chapter: 1,
      topicArea: 'grundlagen-mathematik',
      minLevel: 'einsteiger',
      state: 'approved',
      ordinal: 0,
      sections: ['ch01/ein-abschnitt'],
      prerequisites: [] as readonly string[],
    },
    {
      slug: 'erwartungswert',
      title: 'Erwartungswert',
      chapter: 1,
      topicArea: 'grundlagen-mathematik',
      minLevel: 'fortgeschritten',
      state: 'approved',
      ordinal: 1,
      sections: ['ch01/ein-unterabschnitt'],
      prerequisites: ['pot-odds'],
    },
    {
      slug: 'gleichgewicht',
      title: 'Gleichgewicht',
      chapter: 2,
      topicArea: 'spieltheorie',
      minLevel: 'experte',
      state: 'approved',
      ordinal: 0,
      sections: ['ch02/tabellen-und-diagramme'],
      prerequisites: ['erwartungswert'],
    },
    {
      slug: 'noch-im-entwurf',
      title: 'Noch im Entwurf',
      chapter: 2,
      topicArea: 'spieltheorie',
      minLevel: 'einsteiger',
      state: 'draft',
      ordinal: 1,
      sections: [] as readonly string[],
      prerequisites: [] as readonly string[],
    },
  ] as const;

  for (const entry of conceptRows) {
    const [row] = await db
      .insert(concept)
      .values({
        chapterId: chapterIds[entry.chapter] as string,
        slug: entry.slug,
        title: entry.title,
        summary: `Kurzdefinition zu ${entry.title}.`,
        topicArea: entry.topicArea,
        minLevel: entry.minLevel,
        state: entry.state,
        origin: 'ai',
        ordinal: entry.ordinal,
        unresolvedPrerequisites: entry.slug === 'gleichgewicht' ? ['Varianz'] : [],
      })
      .returning({ id: concept.id });
    conceptIds[entry.slug] = (row as { id: string }).id;
  }

  for (const entry of conceptRows) {
    for (const key of entry.sections) {
      const sectionId = sectionIds[key];
      if (sectionId === undefined) continue;
      await db
        .insert(conceptSection)
        .values({ conceptId: conceptIds[entry.slug] as string, sectionId });
    }
    for (const prerequisite of entry.prerequisites) {
      await db.insert(conceptPrerequisite).values({
        conceptId: conceptIds[entry.slug] as string,
        prerequisiteId: conceptIds[prerequisite] as string,
      });
    }
  }

  // p0003_01 traegt im Fixture "Hand Range 1: BN vs BB (25bb)" mit
  // "Raise 2.2x 41.5% / Fold 58.5%".
  const approvedChartId = await insertChart(db, {
    assetId: assetIds['p0003_01.jpeg'] as string,
    state: 'approved',
    spot: {
      format: null,
      heroPosition: 'BN',
      villainPosition: 'BB',
      stackDepthBb: 25,
      actionSequence: null,
      sizings: ['2.2x'],
    },
    actions: [
      { kind: 'raise', sizing: '2.2x' },
      { kind: 'fold', sizing: null },
    ],
    aggressive: (hand) => hand.length === 2 || hand.startsWith('A'),
    aggressiveKind: 'raise',
    manualHands: ['72o'],
  });

  await insertChart(db, {
    assetId: assetIds['p0005_01.jpeg'] as string,
    state: 'approved',
    spot: {
      format: 'mtt',
      heroPosition: 'SB',
      villainPosition: 'BB',
      stackDepthBb: 15,
      actionSequence: 'Limp vs 3x Raise',
      sizings: ['3x'],
    },
    actions: [
      { kind: 'all_in', sizing: null },
      { kind: 'fold', sizing: null },
    ],
    aggressive: (hand) => hand.length === 2,
    aggressiveKind: 'all_in',
  });

  const rawChartId = await insertChart(db, {
    assetId: assetIds['p0005_02.jpeg'] as string,
    state: 'raw',
    spot: {
      format: null,
      heroPosition: 'BN',
      villainPosition: null,
      stackDepthBb: 25,
      actionSequence: null,
      sizings: [],
    },
    actions: [{ kind: 'raise', sizing: null }],
    aggressive: () => true,
    aggressiveKind: 'raise',
  });

  await db.insert(conceptChart).values({
    conceptId: conceptIds['pot-odds'] as string,
    assetId: assetIds['p0003_01.jpeg'] as string,
    source: 'section',
  });

  return { chapterIds, sectionIds, assetIds, conceptIds, approvedChartId, rawChartId };
}

/** Setzt den Pfad eines Assets - fuer den Pfad-Sicherheitstest. */
export async function setAssetPath(
  db: Database,
  assetId: string,
  relativePath: string,
): Promise<void> {
  await db.update(bookAsset).set({ relativePath }).where(eq(bookAsset.id, assetId));
}
