import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  AssetRef,
  ChapterListResponse,
  ChapterSummary,
  ConceptRef,
  SectionDetail,
  SectionListResponse,
  SectionSummary,
} from '@gto/shared';
import type { BookAssetType, ChartState } from '@gto/shared';
import type { Database } from '../db/client.js';
import {
  bookAsset,
  bookChapter,
  bookSection,
  concept,
  conceptSection,
  rangeChart,
} from '../db/schema.js';
import { assetImageUrl } from './urls.js';

/**
 * Lesepfade auf Kapitel und Sektionen (AP3.T3.5).
 *
 * **Nur lesend.** Dieser Task ändert keine Daten.
 *
 * Der Zuschnitt ist der Kern: Übersichten liefern Zählstände statt Inhalte.
 * `book_section.body` taucht in genau einer Antwort auf — im Sektionsdetail.
 * Alles andere würde AP5 den Prompt fluten.
 */

/** Nur importierte, nicht entfernte Zeilen. */
const liveChapter = isNull(bookChapter.removedAt);
const liveSection = isNull(bookSection.removedAt);
const liveAsset = isNull(bookAsset.removedAt);

function chapterSummaryFrom(row: {
  id: string;
  chapterNumber: number;
  partNumber: number;
  partTitle: string;
  title: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionCount: number;
  conceptCount: number;
  chartCount: number;
}): ChapterSummary {
  return { ...row };
}

/**
 * Alle Kapitel mit Zählständen — **ohne** einen einzigen Volltext.
 *
 * Die drei Zählstände (Sektionen, Konzepte, freigegebene Charts) sind der
 * Grund, warum diese Antwort überhaupt nützlich ist: Sie sagt, wo etwas zu
 * holen ist, ohne es zu liefern.
 */
export async function listChapters(db: Database): Promise<ChapterListResponse> {
  const rows = await db
    .select({
      id: bookChapter.id,
      chapterNumber: bookChapter.chapterNumber,
      partNumber: bookChapter.partNumber,
      partTitle: bookChapter.partTitle,
      title: bookChapter.title,
      ordinal: bookChapter.ordinal,
      pageStart: bookChapter.pageStart,
      pageEnd: bookChapter.pageEnd,
      // Korrelierte Unterabfragen mit **voll qualifizierten** Spalten: Drizzle
      // rendert `bookChapter.id` in einem `sql`-Baustein als blosses "id",
      // und das ist im Kontext der Unterabfrage mehrdeutig.
      sectionCount: sql<number>`(
        select count(*)::int from book_section s
        where s.chapter_id = book_chapter.id and s.removed_at is null
      )`,
      conceptCount: sql<number>`(
        select count(*)::int from concept c where c.chapter_id = book_chapter.id
      )`,
      chartCount: sql<number>`(
        select count(*)::int
        from range_chart rc
        join book_asset a on a.id = rc.asset_id
        join book_section s on s.id = a.section_id
        where s.chapter_id = book_chapter.id and rc.state = 'approved'
      )`,
    })
    .from(bookChapter)
    .where(liveChapter)
    .orderBy(asc(bookChapter.ordinal));

  const chapters = rows.map(chapterSummaryFrom);
  return {
    chapters,
    totals: {
      chapters: chapters.length,
      sections: chapters.reduce((sum, entry) => sum + entry.sectionCount, 0),
      concepts: chapters.reduce((sum, entry) => sum + entry.conceptCount, 0),
      approvedCharts: chapters.reduce((sum, entry) => sum + entry.chartCount, 0),
    },
  };
}

/** Ein einzelnes Kapitel über seine fachliche Nummer. */
export async function findChapter(
  db: Database,
  chapterNumber: number,
): Promise<ChapterSummary | undefined> {
  const { chapters } = await listChapters(db);
  return chapters.find((entry) => entry.chapterNumber === chapterNumber);
}

/**
 * Sektionen eines Kapitels — **ohne** Volltexte, aber mit `bodyChars`.
 *
 * Die Zeichenzahl ist Absicht: AP5 plant damit sein Token-Budget, bevor es
 * überhaupt lädt.
 */
export async function listSections(
  db: Database,
  chapterNumber: number,
): Promise<SectionListResponse | undefined> {
  const chapter = await findChapter(db, chapterNumber);
  if (chapter === undefined) return undefined;

  const rows = await db
    .select({
      id: bookSection.id,
      sectionKey: bookSection.sectionKey,
      title: bookSection.title,
      level: bookSection.level,
      ordinal: bookSection.ordinal,
      pageStart: bookSection.pageStart,
      pageEnd: bookSection.pageEnd,
      bodyChars: sql<number>`length(book_section.body)::int`,
      conceptCount: sql<number>`(
        select count(*)::int from concept_section cs
        where cs.section_id = book_section.id
      )`,
      assetCount: sql<number>`(
        select count(*)::int from book_asset a
        where a.section_id = book_section.id and a.removed_at is null
      )`,
    })
    .from(bookSection)
    .where(and(eq(bookSection.chapterId, chapter.id), liveSection))
    .orderBy(asc(bookSection.ordinal));

  return { chapter, sections: rows as SectionSummary[] };
}

/**
 * Eine einzelne Sektion mit Volltext, Konzepten und Bildern.
 *
 * Der Schlüssel ist der fachliche `section_key` (`ch07/…`) oder die UUID —
 * beides erlaubt, weil AP5 den Schlüssel aus dem Konzeptdetail kennt, ein
 * Werkzeug aber auch eine ID in der Hand haben kann.
 */
export async function getSection(
  db: Database,
  keyOrId: string,
): Promise<SectionDetail | undefined> {
  const [row] = await db
    .select({
      id: bookSection.id,
      sectionKey: bookSection.sectionKey,
      title: bookSection.title,
      level: bookSection.level,
      ordinal: bookSection.ordinal,
      pageStart: bookSection.pageStart,
      pageEnd: bookSection.pageEnd,
      body: bookSection.body,
      chapterNumber: bookChapter.chapterNumber,
      chapterTitle: bookChapter.title,
      partNumber: bookChapter.partNumber,
    })
    .from(bookSection)
    .innerJoin(bookChapter, eq(bookSection.chapterId, bookChapter.id))
    .where(
      and(
        isUuid(keyOrId) ? eq(bookSection.id, keyOrId) : eq(bookSection.sectionKey, keyOrId),
        liveSection,
      ),
    );
  if (!row) return undefined;

  const concepts = await db
    .select({ id: concept.id, slug: concept.slug, title: concept.title })
    .from(conceptSection)
    .innerJoin(concept, eq(conceptSection.conceptId, concept.id))
    .where(eq(conceptSection.sectionId, row.id))
    .orderBy(asc(concept.ordinal));

  const assets = await db
    .select({
      id: bookAsset.id,
      assetType: bookAsset.assetType,
      captionRaw: bookAsset.captionRaw,
      captionNumber: bookAsset.captionNumber,
      chartId: rangeChart.id,
      chartState: rangeChart.state,
    })
    .from(bookAsset)
    .leftJoin(rangeChart, eq(rangeChart.assetId, bookAsset.id))
    .where(and(eq(bookAsset.sectionId, row.id), liveAsset))
    .orderBy(asc(bookAsset.ordinal));

  return {
    ...row,
    bodyChars: row.body.length,
    conceptCount: concepts.length,
    assetCount: assets.length,
    concepts: concepts as ConceptRef[],
    assets: assets.map((entry): AssetRef => ({
      id: entry.id,
      assetType: entry.assetType as BookAssetType,
      captionRaw: entry.captionRaw,
      captionNumber: entry.captionNumber,
      imageUrl: assetImageUrl(entry.id),
      chartId: entry.chartId,
      chartState: entry.chartState as ChartState | null,
    })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unterscheidet UUID von fachlichem Schlüssel. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
