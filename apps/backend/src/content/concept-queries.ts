import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ChartSummary,
  ConceptLevel,
  ConceptRef,
  ConceptState,
  ConceptTopicArea,
  ContentConceptDetail,
  ContentConceptListResponse,
  ContentConceptSummary,
  LearningPathResponse,
  LearningPathStep,
  SectionRef,
} from '@gto/shared';
import { CONCEPT_LEVELS } from '@gto/shared';
import type { Database } from '../db/client.js';
import {
  bookChapter,
  bookSection,
  concept,
  conceptPrerequisite,
  conceptSection,
} from '../db/schema.js';
import { listCharts } from './chart-queries.js';
import { isUuid } from './book-queries.js';

/**
 * Lesepfade auf den Konzept-Graphen (AP3.T3.5).
 *
 * **Nur lesend.** Die Voreinstellung ist `state = 'approved'`: Ein Folge-AP,
 * der nichts angibt, bekommt nur das, was ein Mensch bestätigt hat.
 */

export interface ConceptFilter {
  readonly chapter?: number | undefined;
  readonly topicArea?: ConceptTopicArea | undefined;
  readonly state?: ConceptState | undefined;
  readonly level?: ConceptLevel | undefined;
}

/** Die gemeinsame Auswahl hinter Liste, Detail und Lernpfad. */
function summarySelection() {
  return {
    id: concept.id,
    slug: concept.slug,
    title: concept.title,
    summary: concept.summary,
    topicArea: concept.topicArea,
    minLevel: concept.minLevel,
    state: concept.state,
    ordinal: concept.ordinal,
    chapterNumber: bookChapter.chapterNumber,
    chapterTitle: bookChapter.title,
    unresolvedPrerequisites: concept.unresolvedPrerequisites,
    // Voll qualifiziert - siehe die Anmerkung in `book-queries.ts`.
    prerequisiteCount: sql<number>`(
      select count(*)::int from concept_prerequisite p where p.concept_id = concept.id
    )`,
    dependentCount: sql<number>`(
      select count(*)::int from concept_prerequisite p where p.prerequisite_id = concept.id
    )`,
    sectionCount: sql<number>`(
      select count(*)::int from concept_section cs where cs.concept_id = concept.id
    )`,
    // Zaehlt nur **freigegebene** Charts - dieselbe Regel wie ueberall sonst.
    // Ohne den Join stuende hier die Zahl aller verknuepften Assets, und ein
    // Aufrufer laese "chartCount: 3" neben einem Detail mit einem Chart.
    chartCount: sql<number>`(
      select count(*)::int from concept_chart cc
      join range_chart rc on rc.asset_id = cc.asset_id
      where cc.concept_id = concept.id and rc.state = 'approved'
    )`,
  };
}

function toSummary(row: Record<string, unknown>): ContentConceptSummary {
  return {
    id: row['id'] as string,
    slug: row['slug'] as string,
    title: row['title'] as string,
    summary: row['summary'] as string,
    topicArea: row['topicArea'] as ConceptTopicArea,
    minLevel: row['minLevel'] as ConceptLevel,
    state: row['state'] as ConceptState,
    chapterNumber: row['chapterNumber'] as number,
    chapterTitle: row['chapterTitle'] as string,
    ordinal: row['ordinal'] as number,
    prerequisiteCount: row['prerequisiteCount'] as number,
    dependentCount: row['dependentCount'] as number,
    sectionCount: row['sectionCount'] as number,
    chartCount: row['chartCount'] as number,
  };
}

/**
 * Ein Level schließt die darunterliegenden ein: Wer nach `fortgeschritten`
 * fragt, bekommt auch Einsteiger-Konzepte — sie sind für ihn ebenfalls
 * geeignet. Andersherum nicht.
 */
function levelsUpTo(level: ConceptLevel): ConceptLevel[] {
  const index = CONCEPT_LEVELS.indexOf(level);
  return [...CONCEPT_LEVELS.slice(0, index + 1)];
}

/** Konzeptliste. Ohne Angabe: nur `approved`. */
export async function listConcepts(
  db: Database,
  filter: ConceptFilter = {},
): Promise<ContentConceptListResponse> {
  const state: ConceptState = filter.state ?? 'approved';

  const conditions = [eq(concept.state, state)];
  if (filter.chapter !== undefined) conditions.push(eq(bookChapter.chapterNumber, filter.chapter));
  if (filter.topicArea !== undefined) conditions.push(eq(concept.topicArea, filter.topicArea));
  if (filter.level !== undefined) {
    conditions.push(inArray(concept.minLevel, levelsUpTo(filter.level)));
  }

  const rows = await db
    .select(summarySelection())
    .from(concept)
    .innerJoin(bookChapter, eq(concept.chapterId, bookChapter.id))
    .where(and(...conditions))
    .orderBy(asc(bookChapter.chapterNumber), asc(concept.ordinal));

  const [available] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(concept)
    .where(eq(concept.state, state));

  return {
    concepts: rows.map(toSummary),
    totals: { matched: rows.length, available: available?.n ?? 0 },
    filters: {
      chapter: filter.chapter ?? null,
      topicArea: filter.topicArea ?? null,
      state,
      level: filter.level ?? null,
    },
  };
}

/**
 * Konzeptdetail mit Voraussetzungen in **beide** Richtungen.
 *
 * Die Gegenrichtung ist nicht Zierde: AP5 braucht sie, um nach einer
 * Lerneinheit zu wissen, was jetzt freigeschaltet ist.
 */
export async function getConcept(
  db: Database,
  slugOrId: string,
): Promise<ContentConceptDetail | undefined> {
  const [row] = await db
    .select(summarySelection())
    .from(concept)
    .innerJoin(bookChapter, eq(concept.chapterId, bookChapter.id))
    .where(isUuid(slugOrId) ? eq(concept.id, slugOrId) : eq(concept.slug, slugOrId));
  if (!row) return undefined;

  const summary = toSummary(row);

  const prerequisites = await db
    .select({ id: concept.id, slug: concept.slug, title: concept.title })
    .from(conceptPrerequisite)
    .innerJoin(concept, eq(conceptPrerequisite.prerequisiteId, concept.id))
    .where(eq(conceptPrerequisite.conceptId, summary.id))
    .orderBy(asc(concept.title));

  const dependents = await db
    .select({ id: concept.id, slug: concept.slug, title: concept.title })
    .from(conceptPrerequisite)
    .innerJoin(concept, eq(conceptPrerequisite.conceptId, concept.id))
    .where(eq(conceptPrerequisite.prerequisiteId, summary.id))
    .orderBy(asc(concept.title));

  const sections = await db
    .select({
      id: bookSection.id,
      sectionKey: bookSection.sectionKey,
      title: bookSection.title,
      chapterNumber: bookChapter.chapterNumber,
    })
    .from(conceptSection)
    .innerJoin(bookSection, eq(conceptSection.sectionId, bookSection.id))
    .innerJoin(bookChapter, eq(bookSection.chapterId, bookChapter.id))
    .where(eq(conceptSection.conceptId, summary.id))
    .orderBy(asc(bookChapter.chapterNumber), asc(bookSection.ordinal));

  // Charts laufen ueber denselben Lesepfad wie die Chartliste - damit gilt
  // hier dieselbe Approved-Regel, ohne sie ein zweites Mal zu schreiben.
  const charts = await listCharts(db, { concept: summary.slug });

  const unresolved = row['unresolvedPrerequisites'];

  return {
    ...summary,
    prerequisites: prerequisites as ConceptRef[],
    dependents: dependents as ConceptRef[],
    unresolvedPrerequisites: Array.isArray(unresolved) ? (unresolved as string[]) : [],
    sections: sections as SectionRef[],
    charts: charts.charts as ChartSummary[],
  };
}

/**
 * Lernpfad: topologische Ordnung des Prerequisite-Graphen.
 *
 * Kahns Algorithmus, ebenenweise. Die Ebene ist die eigentlich nützliche
 * Information — Konzepte derselben Ebene sind untereinander unabhängig, und
 * AP5 kann frei wählen, welches es als Nächstes unterrichtet.
 *
 * Voraussetzungen, die **außerhalb** der gefilterten Menge liegen (etwa ein
 * `draft`-Konzept), werden ignoriert. Sonst blockierte ein einziges nicht
 * freigegebenes Konzept den ganzen Pfad.
 */
export async function learningPath(
  db: Database,
  filter: ConceptFilter = {},
): Promise<LearningPathResponse> {
  const { concepts } = await listConcepts(db, filter);
  const byId = new Map(concepts.map((entry) => [entry.id, entry]));

  const edges =
    byId.size === 0
      ? []
      : await db
          .select({
            conceptId: conceptPrerequisite.conceptId,
            prerequisiteId: conceptPrerequisite.prerequisiteId,
          })
          .from(conceptPrerequisite)
          .where(inArray(conceptPrerequisite.conceptId, [...byId.keys()]));

  const needs = new Map<string, Set<string>>();
  const unlocks = new Map<string, string[]>();
  for (const id of byId.keys()) needs.set(id, new Set());

  for (const edge of edges) {
    if (!byId.has(edge.prerequisiteId)) continue; // ausserhalb der Auswahl
    needs.get(edge.conceptId)?.add(edge.prerequisiteId);
    unlocks.set(edge.prerequisiteId, [...(unlocks.get(edge.prerequisiteId) ?? []), edge.conceptId]);
  }

  const steps: LearningPathStep[] = [];
  const done = new Set<string>();
  let tier = 0;

  // Stabile Reihenfolge innerhalb einer Ebene: Kapitel, dann Ordinal - so
  // liest sich der Pfad wie das Buch, wo der Graph es zulaesst.
  const order = (ids: string[]): string[] =>
    ids.sort((a, b) => {
      const left = byId.get(a) as ContentConceptSummary;
      const right = byId.get(b) as ContentConceptSummary;
      return left.chapterNumber - right.chapterNumber || left.ordinal - right.ordinal;
    });

  let ready = order([...byId.keys()].filter((id) => (needs.get(id)?.size ?? 0) === 0));

  while (ready.length > 0) {
    for (const id of ready) {
      steps.push({ step: steps.length + 1, tier, concept: byId.get(id) as ContentConceptSummary });
      done.add(id);
    }
    const next: string[] = [];
    for (const id of ready) {
      for (const dependent of unlocks.get(id) ?? []) {
        const open = needs.get(dependent);
        open?.delete(id);
        if (open?.size === 0 && !done.has(dependent) && !next.includes(dependent)) {
          next.push(dependent);
        }
      }
    }
    ready = order(next);
    tier += 1;
  }

  const cyclic = [...byId.values()]
    .filter((entry) => !done.has(entry.id))
    .map((entry): ConceptRef => ({ id: entry.id, slug: entry.slug, title: entry.title }));

  return {
    steps,
    cyclic,
    totals: { steps: steps.length, tiers: steps.length === 0 ? 0 : tier },
  };
}
