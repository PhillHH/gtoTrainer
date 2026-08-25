import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  bookAsset,
  bookChapter,
  bookSection,
  concept,
  conceptChart,
  conceptPrerequisite,
  conceptSection,
} from '../db/schema.js';
import { findCycles, selectAcyclicEdges } from './graph.js';
import type { PrerequisiteEdge } from './graph.js';
import { resolvePrerequisiteTitles, resolveSectionKeys } from './resolve.js';
import type { NormalizedConcept } from './normalize.js';

/**
 * Datenbankzugriffe des Konzept-Graphen (AP3.T3.2).
 *
 * Alles hier ist deterministischer Code. Der einzige KI-Anteil des Tasks steckt
 * im Job-Handler, der die Vorschlaege erzeugt; ab hier raeumt der Code auf.
 */

/* -------------------------------------------------------------------------
 * Eingabe fuer die Generierung
 * ---------------------------------------------------------------------- */

export interface ChapterSection {
  readonly id: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Zeichenbudget je Teillauf.
 *
 * Kontextdisziplin: Das laengste Kapitel des Buches hat rund 78 000 Zeichen -
 * als ein Prompt waere das teuer und wuerde die Aufmerksamkeit des Modells auf
 * den hinteren Teil verlieren.
 *
 * Der Wert ist am tatsaechlichen Laufzeitverhalten kalibriert, nicht geschaetzt:
 * Mit 45 000 Zeichen (~12 000 Token) brauchte ein einzelner Aufruf ueber die
 * Claude CLI mehr als zehn Minuten und lief ins Zeitlimit. Bei 15 000 Zeichen
 * antwortet derselbe Aufruf in ein bis zwei Minuten. Die Gesamtmenge an
 * Eingabetext bleibt dieselbe - sie verteilt sich nur auf mehr, dafuer
 * einzeln wiederholbare Laeufe.
 */
export const PART_CHAR_BUDGET = 15_000;

/** Sektionen eines Kapitels, in Buchreihenfolge. */
export async function loadChapterSections(
  db: Database,
  chapterNumber: number,
): Promise<ChapterSection[]> {
  const rows = await db
    .select({
      id: bookSection.id,
      sectionKey: bookSection.sectionKey,
      title: bookSection.title,
      body: bookSection.body,
    })
    .from(bookSection)
    .innerJoin(bookChapter, eq(bookSection.chapterId, bookChapter.id))
    .where(and(eq(bookChapter.chapterNumber, chapterNumber), isNull(bookSection.removedAt)))
    .orderBy(asc(bookSection.ordinal));
  return rows;
}

/**
 * Teilt die Sektionen eines Kapitels in Gruppen, die je unter dem Budget
 * bleiben. Eine Sektion wird nie zerschnitten - sie ist die kleinste Einheit,
 * die noch fuer sich verstaendlich ist.
 */
export function planChapterParts(
  sections: readonly ChapterSection[],
  budget: number = PART_CHAR_BUDGET,
): ChapterSection[][] {
  if (sections.length === 0) return [];

  const parts: ChapterSection[][] = [];
  let current: ChapterSection[] = [];
  let size = 0;

  for (const section of sections) {
    const length = section.body.length + section.title.length;
    if (current.length > 0 && size + length > budget) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += length;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Kapitel mit Nummer und Titel, in Buchreihenfolge. */
export async function loadChapters(
  db: Database,
): Promise<{ id: string; chapterNumber: number; title: string; partNumber: number }[]> {
  return db
    .select({
      id: bookChapter.id,
      chapterNumber: bookChapter.chapterNumber,
      title: bookChapter.title,
      partNumber: bookChapter.partNumber,
    })
    .from(bookChapter)
    .where(isNull(bookChapter.removedAt))
    .orderBy(asc(bookChapter.chapterNumber));
}

/** Verzeichnis der bereits bekannten Konzepte: Slug -> ID, plus Titel. */
export async function loadConceptIndex(db: Database): Promise<{
  bySlug: Map<string, string>;
  titles: { slug: string; title: string; chapterNumber: number }[];
}> {
  const rows = await db
    .select({
      id: concept.id,
      slug: concept.slug,
      title: concept.title,
      chapterNumber: bookChapter.chapterNumber,
    })
    .from(concept)
    .innerJoin(bookChapter, eq(concept.chapterId, bookChapter.id))
    .orderBy(asc(bookChapter.chapterNumber), asc(concept.ordinal));

  const bySlug = new Map(rows.map((row) => [row.slug, row.id]));
  return {
    bySlug,
    titles: rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      chapterNumber: row.chapterNumber,
    })),
  };
}

/* -------------------------------------------------------------------------
 * Persistenz
 * ---------------------------------------------------------------------- */

export interface PersistResult {
  readonly inserted: number;
  /** Vorschlaege, die auf ein bereits vorhandenes Konzept trafen. */
  readonly mergedIntoExisting: number;
  /** Voraussetzungen, die sich nicht aufloesen liessen. */
  readonly unresolvedPrerequisites: number;
  /** Kanten, die einen Zyklus geschlossen haetten und deshalb nicht gespeichert wurden. */
  readonly rejectedEdges: number;
  /** Sektionsverweise, die auf keinen bekannten Schluessel zeigten. */
  readonly unresolvedSections: number;
  readonly conceptIds: readonly string[];
}

/**
 * Schreibt normalisierte Vorschlaege eines Kapitels.
 *
 * Ablauf, bewusst in dieser Reihenfolge:
 * 1. Konzepte anlegen (Dubletten ueber `slug` erkennen und zusammenfuehren),
 * 2. Sektionsverweise aufloesen und verknuepfen,
 * 3. Voraussetzungen aufloesen - erst jetzt, damit Verweise **innerhalb**
 *    desselben Laufs schon greifen,
 * 4. Kanten, die einen Zyklus schliessen wuerden, aussortieren.
 */
export async function persistConcepts(
  db: Database,
  chapterNumber: number,
  concepts: readonly NormalizedConcept[],
): Promise<PersistResult> {
  const [chapter] = await db
    .select({ id: bookChapter.id })
    .from(bookChapter)
    .where(eq(bookChapter.chapterNumber, chapterNumber));
  if (!chapter) {
    throw new Error(`Kapitel ${chapterNumber} existiert nicht. Wurde der Buchimport ausgefuehrt?`);
  }

  const sectionRows = await db
    .select({ id: bookSection.id, sectionKey: bookSection.sectionKey })
    .from(bookSection)
    .where(isNull(bookSection.removedAt));
  const sectionByKey = new Map(sectionRows.map((row) => [row.sectionKey, row.id]));

  const index = await loadConceptIndex(db);
  const [{ maxOrdinal = -1 } = {}] = await db
    .select({ maxOrdinal: sql<number>`coalesce(max(${concept.ordinal}), -1)::int` })
    .from(concept)
    .where(eq(concept.chapterId, chapter.id));

  let ordinal = maxOrdinal + 1;
  let inserted = 0;
  let mergedIntoExisting = 0;
  let unresolvedSections = 0;
  const conceptIds: string[] = [];
  const pending: { id: string; titles: readonly string[] }[] = [];

  for (const candidate of concepts) {
    let id = index.bySlug.get(candidate.slug);

    if (id === undefined) {
      const [row] = await db
        .insert(concept)
        .values({
          chapterId: chapter.id,
          slug: candidate.slug,
          title: candidate.title,
          summary: candidate.summary,
          topicArea: candidate.topicArea,
          minLevel: candidate.minLevel,
          state: 'draft',
          origin: 'ai',
          ordinal: ordinal++,
        })
        .returning({ id: concept.id });
      id = (row as { id: string }).id;
      index.bySlug.set(candidate.slug, id);
      inserted += 1;
    } else {
      // Dublette ueber Kapitelgrenzen: Das Konzept bleibt, wo es zuerst
      // eingefuehrt wurde. Ergaenzt werden nur die Sektionsverweise - das
      // Konzept wird in mehreren Kapiteln behandelt, nicht neu erfunden.
      mergedIntoExisting += 1;
    }

    conceptIds.push(id);

    const sections = resolveSectionKeys(candidate.sectionKeys, sectionByKey);
    unresolvedSections += sections.unresolved.length;
    for (const sectionId of sections.ids) {
      await db.insert(conceptSection).values({ conceptId: id, sectionId }).onConflictDoNothing();
    }

    pending.push({ id, titles: candidate.prerequisiteTitles });
  }

  // Voraussetzungen erst nach allen Einfuegungen: So zeigen Verweise auf
  // Konzepte desselben Laufs bereits auf eine echte ID.
  const existingEdges = await db
    .select({
      conceptId: conceptPrerequisite.conceptId,
      prerequisiteId: conceptPrerequisite.prerequisiteId,
    })
    .from(conceptPrerequisite);

  const proposed: PrerequisiteEdge[] = [];
  let unresolvedPrerequisites = 0;

  for (const entry of pending) {
    const resolved = resolvePrerequisiteTitles(entry.titles, index.bySlug, entry.id);
    unresolvedPrerequisites += resolved.unresolved.length;
    if (resolved.unresolved.length > 0) {
      await db
        .update(concept)
        .set({ unresolvedPrerequisites: resolved.unresolved, updatedAt: new Date() })
        .where(eq(concept.id, entry.id));
    }
    for (const prerequisiteId of resolved.ids) {
      proposed.push({ conceptId: entry.id, prerequisiteId });
    }
  }

  const { accepted, rejected } = selectAcyclicEdges([...existingEdges, ...proposed]);
  const acceptedKeys = new Set(accepted.map((edge) => `${edge.conceptId}>${edge.prerequisiteId}`));

  for (const edge of proposed) {
    if (!acceptedKeys.has(`${edge.conceptId}>${edge.prerequisiteId}`)) continue;
    await db
      .insert(conceptPrerequisite)
      .values({ conceptId: edge.conceptId, prerequisiteId: edge.prerequisiteId })
      .onConflictDoNothing();
  }

  return {
    inserted,
    mergedIntoExisting,
    unresolvedPrerequisites,
    rejectedEdges: rejected.length,
    unresolvedSections,
    conceptIds,
  };
}

/* -------------------------------------------------------------------------
 * Chart-Zuordnung (Subtask 6) - deterministisch, ohne KI
 * ---------------------------------------------------------------------- */

/**
 * Verknuepft `hand_range`-Assets mit Konzepten ueber die Sektion, in der das
 * Asset steht.
 *
 * Bewusst grob: Steht ein Chart in einer Sektion, die einem Konzept zugeordnet
 * ist, gehoert es zunaechst zu diesem Konzept. T3.3/T3.4 verfeinern das mit den
 * dann vorhandenen Spot-Metadaten. Eine KI ist dafuer hier nicht noetig - und
 * waere fuer eine Zuordnung, die ohnehin ueberschrieben wird, verschwendetes
 * Kontingent.
 */
export async function assignChartsBySection(db: Database): Promise<{ links: number }> {
  const rows = await db
    .select({ conceptId: conceptSection.conceptId, assetId: bookAsset.id })
    .from(conceptSection)
    .innerJoin(bookAsset, eq(bookAsset.sectionId, conceptSection.sectionId))
    .where(and(eq(bookAsset.assetType, 'hand_range'), isNull(bookAsset.removedAt)));

  let links = 0;
  for (const row of rows) {
    const result = await db
      .insert(conceptChart)
      .values({ conceptId: row.conceptId, assetId: row.assetId, source: 'section' })
      .onConflictDoNothing()
      .returning({ conceptId: conceptChart.conceptId });
    links += result.length;
  }
  return { links };
}

/* -------------------------------------------------------------------------
 * Auffaelligkeiten
 * ---------------------------------------------------------------------- */

export interface ConceptGraphIssues {
  readonly cycles: string[][];
  readonly withoutSection: { id: string; title: string }[];
  readonly unresolved: { id: string; title: string; titles: string[] }[];
  readonly emptyChapters: number[];
}

/** Sammelt alles, was in der Review-Ansicht auffallen soll. */
export async function collectIssues(db: Database): Promise<ConceptGraphIssues> {
  const edges = await db
    .select({
      conceptId: conceptPrerequisite.conceptId,
      prerequisiteId: conceptPrerequisite.prerequisiteId,
    })
    .from(conceptPrerequisite);

  const withoutSection = await db
    .select({ id: concept.id, title: concept.title })
    .from(concept)
    .where(
      sql`not exists (select 1 from ${conceptSection} where ${conceptSection.conceptId} = ${concept.id})`,
    )
    .orderBy(asc(concept.title));

  const unresolvedRows = await db
    .select({
      id: concept.id,
      title: concept.title,
      titles: concept.unresolvedPrerequisites,
    })
    .from(concept)
    .where(sql`jsonb_array_length(${concept.unresolvedPrerequisites}) > 0`)
    .orderBy(asc(concept.title));

  const chapters = await loadChapters(db);
  const counts = await db
    .select({ chapterId: concept.chapterId, n: sql<number>`count(*)::int` })
    .from(concept)
    .groupBy(concept.chapterId);
  const byChapterId = new Map(counts.map((row) => [row.chapterId, row.n]));

  return {
    cycles: findCycles(edges),
    withoutSection,
    unresolved: unresolvedRows.map((row) => ({
      id: row.id,
      title: row.title,
      titles: Array.isArray(row.titles) ? (row.titles as string[]) : [],
    })),
    emptyChapters: chapters
      .filter((chapter) => (byChapterId.get(chapter.id) ?? 0) === 0)
      .map((chapter) => chapter.chapterNumber),
  };
}

/** Setzt Voraussetzungen eines Konzepts vollstaendig neu (Review-Ansicht). */
export async function replacePrerequisites(
  db: Database,
  conceptId: string,
  prerequisiteIds: readonly string[],
): Promise<{ accepted: string[]; rejected: string[] }> {
  const others = await db
    .select({
      conceptId: conceptPrerequisite.conceptId,
      prerequisiteId: conceptPrerequisite.prerequisiteId,
    })
    .from(conceptPrerequisite)
    .where(sql`${conceptPrerequisite.conceptId} <> ${conceptId}`);

  const accepted: string[] = [];
  const rejected: string[] = [];
  const kept: PrerequisiteEdge[] = [...others];

  for (const prerequisiteId of prerequisiteIds) {
    if (prerequisiteId === conceptId) {
      rejected.push(prerequisiteId);
      continue;
    }
    const candidate: PrerequisiteEdge = { conceptId, prerequisiteId };
    if (findCycles([...kept, candidate]).length > 0) {
      rejected.push(prerequisiteId);
      continue;
    }
    kept.push(candidate);
    accepted.push(prerequisiteId);
  }

  await db.delete(conceptPrerequisite).where(eq(conceptPrerequisite.conceptId, conceptId));
  if (accepted.length > 0) {
    await db
      .insert(conceptPrerequisite)
      .values(accepted.map((prerequisiteId) => ({ conceptId, prerequisiteId })))
      .onConflictDoNothing();
  }

  return { accepted, rejected };
}

/** Prueft, ob alle genannten IDs existierende Konzepte sind. */
export async function existingConceptIds(
  db: Database,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: concept.id })
    .from(concept)
    .where(inArray(concept.id, [...ids]));
  return new Set(rows.map((row) => row.id));
}
