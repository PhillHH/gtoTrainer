import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CONCEPT_LEVELS,
  CONCEPT_TOPIC_AREAS,
  isConceptLevel,
  isConceptState,
  isConceptTopicArea,
} from '@gto/shared';
import type {
  ConceptApproveResponse,
  ConceptChapterGroup,
  ConceptDetail,
  ConceptErrorResponse,
  ConceptIssue,
  ConceptLevel,
  ConceptListResponse,
  ConceptOrigin,
  ConceptState,
  ConceptTopicArea,
  ConceptUpdate,
  ConceptUpdateResponse,
} from '@gto/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { sendAuthError } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import {
  bookChapter,
  concept,
  conceptChart,
  conceptPrerequisite,
  conceptSection,
} from '../db/schema.js';
import { collectIssues, existingConceptIds, replacePrerequisites } from './store.js';

/**
 * Review-Ansicht des Konzept-Graphen (AP3.T3.2, Subtask 7).
 *
 * **Abgrenzung zu T3.5:** Das hier ist die Pruefoberflaeche fuer die
 * KI-Vorschlaege - Liste, Bearbeiten, Bestaetigen. Die Content-API fuer
 * Folge-APs (gezielter Kapitel-/Sektions-/Chart-Abruf, Spot-Suche,
 * Asset-Auslieferung) entsteht in T3.5 unter `/api/content` und ist hier
 * bewusst **nicht** vorweggenommen.
 *
 * Alle Routen haengen an `app.requireSession`; die schreibenden sind ueber den
 * globalen CSRF-Hook aus T1.3 abgesichert.
 */

export interface ConceptRoutesOptions {
  readonly db: Database;
}

interface ConceptRow {
  id: string;
  chapterNumber: number;
  chapterTitle: string;
  partNumber: number;
  title: string;
  summary: string;
  topicArea: string;
  minLevel: string;
  state: string;
  origin: string;
  ordinal: number;
  unresolvedPrerequisites: unknown;
}

export function registerConceptRoutes(app: FastifyInstance, options: ConceptRoutesOptions): void {
  const { db } = options;

  /** `GET /api/concepts` - alle Konzepte nach Kapitel gruppiert, samt Befunden. */
  app.get('/api/concepts', { preHandler: app.requireSession }, async (_request, reply) => {
    return reply.send(await buildList(db));
  });

  /** `PATCH /api/concepts/:id` - Titel, Definition, Einordnung, Voraussetzungen. */
  app.patch<{ Params: { id: string }; Body: ConceptUpdate }>(
    '/api/concepts/:id',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const patch = request.body;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return sendAuthError(reply, 400, 'invalid_request', 'Der Rumpf muss ein Objekt sein.');
      }

      const [existing] = await db.select().from(concept).where(eq(concept.id, request.params.id));
      if (!existing) {
        return sendAuthError(reply, 404, 'invalid_request', 'Konzept nicht gefunden.');
      }

      const fields: { field: string; message: string }[] = [];
      const values: Record<string, unknown> = {};

      if (patch.title !== undefined) {
        const title = String(patch.title).trim();
        if (title === '') fields.push({ field: 'title', message: 'Titel darf nicht leer sein.' });
        else values['title'] = title;
      }
      if (patch.summary !== undefined) {
        const summary = String(patch.summary).trim();
        if (summary === '')
          fields.push({ field: 'summary', message: 'Kurzdefinition darf nicht leer sein.' });
        else values['summary'] = summary;
      }
      if (patch.topicArea !== undefined) {
        if (!isConceptTopicArea(patch.topicArea)) {
          fields.push({
            field: 'topicArea',
            message: `Unbekannter Themenbereich. Erlaubt: ${CONCEPT_TOPIC_AREAS.map((area) => area.id).join(', ')}.`,
          });
        } else values['topicArea'] = patch.topicArea;
      }
      if (patch.minLevel !== undefined) {
        if (!isConceptLevel(patch.minLevel)) {
          fields.push({
            field: 'minLevel',
            message: `Unbekanntes Level. Erlaubt: ${CONCEPT_LEVELS.join(', ')}.`,
          });
        } else values['minLevel'] = patch.minLevel;
      }
      if (patch.state !== undefined) {
        if (!isConceptState(patch.state)) {
          fields.push({ field: 'state', message: 'Zustand muss "draft" oder "approved" sein.' });
        } else values['state'] = patch.state;
      }

      let rejectedPrerequisites: string[] = [];
      if (patch.prerequisiteIds !== undefined) {
        if (!Array.isArray(patch.prerequisiteIds)) {
          fields.push({ field: 'prerequisiteIds', message: 'Erwartet wird eine Liste von IDs.' });
        } else {
          const known = await existingConceptIds(db, patch.prerequisiteIds);
          const unknown = patch.prerequisiteIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            fields.push({
              field: 'prerequisiteIds',
              message: `Unbekannte Konzept-IDs: ${unknown.join(', ')}.`,
            });
          }
        }
      }

      if (fields.length > 0) {
        const body: ConceptErrorResponse = {
          error: 'invalid_concept',
          message: 'Die Änderung wurde abgelehnt.',
          fields,
        };
        return reply.code(400).send(body);
      }

      if (patch.prerequisiteIds !== undefined) {
        // Eine Kante, die einen Zyklus schliessen wuerde, wird nicht
        // gespeichert - der Graph bleibt jederzeit ableitbar. Die Ablehnung
        // wird gemeldet, statt still zu verschwinden.
        const result = await replacePrerequisites(db, existing.id, patch.prerequisiteIds);
        rejectedPrerequisites = result.rejected;
        // Von Hand gesetzte Voraussetzungen loesen die offenen Titel ab.
        values['unresolvedPrerequisites'] = [];
      }

      if (Object.keys(values).length > 0) {
        await db
          .update(concept)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(concept.id, existing.id));
      }

      if (rejectedPrerequisites.length > 0) {
        const body: ConceptErrorResponse = {
          error: 'invalid_concept',
          message: 'Einzelne Voraussetzungen wurden abgelehnt, weil sie einen Zyklus erzeugen.',
          fields: rejectedPrerequisites.map((id) => ({
            field: 'prerequisiteIds',
            message: `"${id}" würde einen Zyklus schließen.`,
          })),
        };
        return reply.code(400).send(body);
      }

      const detail = await loadDetail(db, existing.id);
      if (!detail) {
        return sendAuthError(reply, 404, 'invalid_request', 'Konzept nicht gefunden.');
      }
      const body: ConceptUpdateResponse = { concept: detail };
      return reply.send(body);
    },
  );

  /** `POST /api/concepts/:id/approve` - ein Konzept bestaetigen. */
  app.post<{ Params: { id: string } }>(
    '/api/concepts/:id/approve',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const rows = await db
        .update(concept)
        .set({ state: 'approved', updatedAt: new Date() })
        .where(and(eq(concept.id, request.params.id), eq(concept.state, 'draft')))
        .returning({ id: concept.id });

      if (rows.length === 0) {
        const [exists] = await db
          .select({ id: concept.id })
          .from(concept)
          .where(eq(concept.id, request.params.id));
        if (!exists) {
          return sendAuthError(reply, 404, 'invalid_request', 'Konzept nicht gefunden.');
        }
      }
      const body: ConceptApproveResponse = { approved: rows.length };
      return reply.send(body);
    },
  );

  /** `POST /api/concepts/chapters/:chapterNumber/approve` - Sammelaktion. */
  app.post<{ Params: { chapterNumber: string } }>(
    '/api/concepts/chapters/:chapterNumber/approve',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const chapterNumber = Number(request.params.chapterNumber);
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        return sendAuthError(reply, 400, 'invalid_request', 'Ungültige Kapitelnummer.');
      }

      const [chapter] = await db
        .select({ id: bookChapter.id })
        .from(bookChapter)
        .where(eq(bookChapter.chapterNumber, chapterNumber));
      if (!chapter) {
        return sendAuthError(reply, 404, 'invalid_request', 'Kapitel nicht gefunden.');
      }

      const rows = await db
        .update(concept)
        .set({ state: 'approved', updatedAt: new Date() })
        .where(and(eq(concept.chapterId, chapter.id), eq(concept.state, 'draft')))
        .returning({ id: concept.id });

      const body: ConceptApproveResponse = { approved: rows.length };
      return reply.send(body);
    },
  );
}

/* -------------------------------------------------------------------------
 * Lesepfad
 * ---------------------------------------------------------------------- */

async function selectRows(db: Database, id?: string): Promise<ConceptRow[]> {
  const query = db
    .select({
      id: concept.id,
      chapterNumber: bookChapter.chapterNumber,
      chapterTitle: bookChapter.title,
      partNumber: bookChapter.partNumber,
      title: concept.title,
      summary: concept.summary,
      topicArea: concept.topicArea,
      minLevel: concept.minLevel,
      state: concept.state,
      origin: concept.origin,
      ordinal: concept.ordinal,
      unresolvedPrerequisites: concept.unresolvedPrerequisites,
    })
    .from(concept)
    .innerJoin(bookChapter, eq(concept.chapterId, bookChapter.id))
    .$dynamic();

  const rows = id
    ? await query.where(eq(concept.id, id))
    : await query.orderBy(asc(bookChapter.chapterNumber), asc(concept.ordinal));
  return rows;
}

/** Voraussetzungen, Sektions- und Chartzahlen fuer eine Menge von Konzepten. */
async function loadRelations(db: Database): Promise<{
  prerequisites: Map<string, { id: string; title: string }[]>;
  sections: Map<string, number>;
  charts: Map<string, number>;
}> {
  const prerequisiteRows = await db
    .select({
      conceptId: conceptPrerequisite.conceptId,
      id: concept.id,
      title: concept.title,
    })
    .from(conceptPrerequisite)
    .innerJoin(concept, eq(conceptPrerequisite.prerequisiteId, concept.id))
    .orderBy(asc(concept.title));

  const prerequisites = new Map<string, { id: string; title: string }[]>();
  for (const row of prerequisiteRows) {
    const list = prerequisites.get(row.conceptId) ?? [];
    list.push({ id: row.id, title: row.title });
    prerequisites.set(row.conceptId, list);
  }

  const sectionRows = await db
    .select({ conceptId: conceptSection.conceptId, n: sql<number>`count(*)::int` })
    .from(conceptSection)
    .groupBy(conceptSection.conceptId);
  const chartRows = await db
    .select({ conceptId: conceptChart.conceptId, n: sql<number>`count(*)::int` })
    .from(conceptChart)
    .groupBy(conceptChart.conceptId);

  return {
    prerequisites,
    sections: new Map(sectionRows.map((row) => [row.conceptId, row.n])),
    charts: new Map(chartRows.map((row) => [row.conceptId, row.n])),
  };
}

function toDetail(
  row: ConceptRow,
  relations: Awaited<ReturnType<typeof loadRelations>>,
): ConceptDetail {
  return {
    id: row.id,
    chapterNumber: row.chapterNumber,
    chapterTitle: row.chapterTitle,
    title: row.title,
    summary: row.summary,
    topicArea: row.topicArea as ConceptTopicArea,
    minLevel: row.minLevel as ConceptLevel,
    state: row.state as ConceptState,
    origin: row.origin as ConceptOrigin,
    ordinal: row.ordinal,
    prerequisites: relations.prerequisites.get(row.id) ?? [],
    unresolvedPrerequisites: Array.isArray(row.unresolvedPrerequisites)
      ? (row.unresolvedPrerequisites as string[])
      : [],
    sectionCount: relations.sections.get(row.id) ?? 0,
    chartCount: relations.charts.get(row.id) ?? 0,
  };
}

async function loadDetail(db: Database, id: string): Promise<ConceptDetail | undefined> {
  const [row] = await selectRows(db, id);
  if (!row) return undefined;
  return toDetail(row, await loadRelations(db));
}

/** Baut die vollstaendige Antwort von `GET /api/concepts`. */
export async function buildList(db: Database): Promise<ConceptListResponse> {
  const rows = await selectRows(db);
  const relations = await loadRelations(db);
  const details = rows.map((row) => toDetail(row, relations));
  const titleById = new Map(details.map((detail) => [detail.id, detail.title]));

  const groups = new Map<number, ConceptChapterGroup>();
  const chapters = await db
    .select({
      chapterNumber: bookChapter.chapterNumber,
      title: bookChapter.title,
      partNumber: bookChapter.partNumber,
    })
    .from(bookChapter)
    .orderBy(asc(bookChapter.chapterNumber));

  for (const chapter of chapters) {
    groups.set(chapter.chapterNumber, {
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.title,
      partNumber: chapter.partNumber,
      concepts: [],
    });
  }
  for (const detail of details) {
    const group = groups.get(detail.chapterNumber);
    if (!group) continue;
    (group.concepts as ConceptDetail[]).push(detail);
  }

  const found = await collectIssues(db);
  const issues: ConceptIssue[] = [];

  for (const cycle of found.cycles) {
    issues.push({
      kind: 'cycle',
      detail: `Zyklus: ${cycle.map((id) => titleById.get(id) ?? id).join(' → ')}`,
      conceptIds: [...new Set(cycle)],
    });
  }
  for (const entry of found.unresolved) {
    issues.push({
      kind: 'unresolved-prerequisite',
      detail: `"${entry.title}" verweist auf unbekannte Voraussetzungen: ${entry.titles.join(', ')}`,
      conceptIds: [entry.id],
    });
  }
  for (const entry of found.withoutSection) {
    issues.push({
      kind: 'without-section',
      detail: `"${entry.title}" ist keiner Buchsektion zugeordnet.`,
      conceptIds: [entry.id],
    });
  }
  for (const chapterNumber of found.emptyChapters) {
    issues.push({
      kind: 'chapter-empty',
      detail: `Kapitel ${chapterNumber} hat kein einziges Konzept.`,
      conceptIds: [],
    });
  }

  return {
    chapters: [...groups.values()],
    issues,
    topicAreas: CONCEPT_TOPIC_AREAS.map((area) => ({ id: area.id, label: area.label })),
    levels: [...CONCEPT_LEVELS],
    totals: {
      concepts: details.length,
      draft: details.filter((detail) => detail.state === 'draft').length,
      approved: details.filter((detail) => detail.state === 'approved').length,
      withoutSection: found.withoutSection.length,
    },
  };
}
