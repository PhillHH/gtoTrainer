import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CHART_FORMATS,
  CHART_POSITIONS,
  CONCEPT_LEVELS,
  CONCEPT_STATES,
  CONCEPT_TOPIC_AREA_IDS,
  SPOT_STACK_TOLERANCE_BB,
  isChartHand,
} from '@gto/shared';
import type {
  ChartFormat,
  ChartPosition,
  ConceptLevel,
  ConceptState,
  ConceptTopicArea,
  ContentErrorCode,
  ContentErrorResponse,
} from '@gto/shared';
import type { Database } from '../db/client.js';
import { ASSET_CACHE_CONTROL, isAssetProblem, loadAsset } from './assets.js';
import { getSection, listChapters, listSections } from './book-queries.js';
import { getConcept, learningPath, listConcepts } from './concept-queries.js';
import { getCell, getChart, listCharts } from './chart-queries.js';
import { searchSpots } from './spot-search.js';

/**
 * Content-API (AP3.T3.5).
 *
 * Ab hier läuft alles, was AP5 bis AP8 aus der Wissensbasis brauchen, über
 * diese Routen. Drei Eigenschaften gelten ausnahmslos:
 *
 * - **Alles hängt am Auth-Guard aus T1.3.** Es gibt keine öffentliche
 *   Content-Route, auch nicht für Bilder.
 * - **Nur lesend.** Kein `POST`, kein `PATCH`. Dieser Task ändert keine Daten.
 * - **Nur `approved` Charts**, sofern nicht `includeUnapproved=true` gesetzt
 *   ist — der Parameter ist der Review-Ansicht aus T3.4 vorbehalten.
 */

export interface ContentRoutesOptions {
  readonly db: Database;
  /** Abweichendes Quellverzeichnis der Bilder — nur für Tests. */
  readonly sourceDir?: string;
}

function fail(
  reply: FastifyReply,
  status: number,
  error: ContentErrorCode,
  message: string,
  allowed?: readonly string[],
): FastifyReply {
  const body: ContentErrorResponse = {
    error,
    message,
    ...(allowed === undefined ? {} : { allowed }),
  };
  return reply.code(status).send(body);
}

/** Liest einen Query-Parameter als Wert aus einer geschlossenen Menge. */
function pickFrom<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): { ok: true; value: T | undefined } | { ok: false; allowed: readonly T[] } {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as T };
  }
  return { ok: false, allowed };
}

/** Liest einen Query-Parameter als Zahl. */
function pickNumber(raw: unknown): number | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 'invalid';
}

export function registerContentRoutes(app: FastifyInstance, options: ContentRoutesOptions): void {
  const { db } = options;
  const guard = { preHandler: app.requireSession };

  /* --------------------------------------------------------------------
   * Kapitel und Sektionen
   * ------------------------------------------------------------------ */

  /** `GET /api/content/chapters` — Übersicht, **ohne** Volltexte. */
  app.get('/api/content/chapters', guard, async (_request, reply) => {
    return reply.send(await listChapters(db));
  });

  /** `GET /api/content/chapters/:chapterNumber/sections` — **ohne** Volltexte. */
  app.get<{ Params: { chapterNumber: string } }>(
    '/api/content/chapters/:chapterNumber/sections',
    guard,
    async (request, reply) => {
      const number = Number(request.params.chapterNumber);
      if (!Number.isInteger(number)) {
        return fail(reply, 400, 'invalid_request', 'Die Kapitelnummer muss eine Ganzzahl sein.');
      }
      const result = await listSections(db, number);
      if (result === undefined) {
        return fail(reply, 404, 'not_found', `Kapitel ${number} gibt es nicht.`);
      }
      return reply.send(result);
    },
  );

  /**
   * `GET /api/content/sections/*` — eine einzelne Sektion **mit** Volltext.
   *
   * Der Platzhalter ist ein Wildcard, weil der fachliche Schlüssel selbst
   * einen Schrägstrich enthält (`ch07/small-blind-pfi-strategy`). Eine UUID
   * geht ebenso.
   */
  app.get<{ Params: { '*': string } }>('/api/content/sections/*', guard, async (request, reply) => {
    const key = request.params['*'];
    if (key === undefined || key === '') {
      return fail(reply, 400, 'invalid_request', 'Es fehlt der Sektionsschlüssel.');
    }
    const section = await getSection(db, key);
    if (section === undefined) {
      return fail(reply, 404, 'not_found', `Die Sektion "${key}" gibt es nicht.`);
    }
    return reply.send(section);
  });

  /* --------------------------------------------------------------------
   * Konzepte
   * ------------------------------------------------------------------ */

  /** `GET /api/content/concepts` — gefiltert; ohne Angabe nur `approved`. */
  app.get<{
    Querystring: { chapter?: string; topicArea?: string; state?: string; level?: string };
  }>('/api/content/concepts', guard, async (request, reply) => {
    const chapter = pickNumber(request.query.chapter);
    if (chapter === 'invalid') {
      return fail(reply, 400, 'invalid_request', '"chapter" muss eine Zahl sein.');
    }

    const topicArea = pickFrom<ConceptTopicArea>(
      request.query.topicArea,
      CONCEPT_TOPIC_AREA_IDS as readonly ConceptTopicArea[],
    );
    if (!topicArea.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekannter Themenbereich.', topicArea.allowed);
    }

    const state = pickFrom<ConceptState>(request.query.state, CONCEPT_STATES);
    if (!state.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekannter Zustand.', state.allowed);
    }

    const level = pickFrom<ConceptLevel>(request.query.level, CONCEPT_LEVELS);
    if (!level.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekanntes Level.', level.allowed);
    }

    return reply.send(
      await listConcepts(db, {
        chapter,
        topicArea: topicArea.value,
        state: state.value,
        level: level.value,
      }),
    );
  });

  /**
   * `GET /api/content/concepts/learning-path` — gültige Unterrichtsreihenfolge.
   *
   * Steht **vor** `/:slugOrId`, sonst würde der Platzhalter „learning-path"
   * als Konzept-Slug verschlucken.
   */
  app.get<{ Querystring: { chapter?: string; topicArea?: string; state?: string } }>(
    '/api/content/concepts/learning-path',
    guard,
    async (request, reply) => {
      const chapter = pickNumber(request.query.chapter);
      if (chapter === 'invalid') {
        return fail(reply, 400, 'invalid_request', '"chapter" muss eine Zahl sein.');
      }
      const topicArea = pickFrom<ConceptTopicArea>(
        request.query.topicArea,
        CONCEPT_TOPIC_AREA_IDS as readonly ConceptTopicArea[],
      );
      if (!topicArea.ok) {
        return fail(reply, 400, 'invalid_request', 'Unbekannter Themenbereich.', topicArea.allowed);
      }
      const state = pickFrom<ConceptState>(request.query.state, CONCEPT_STATES);
      if (!state.ok) {
        return fail(reply, 400, 'invalid_request', 'Unbekannter Zustand.', state.allowed);
      }
      return reply.send(
        await learningPath(db, {
          chapter,
          topicArea: topicArea.value,
          state: state.value,
        }),
      );
    },
  );

  /** `GET /api/content/concepts/:slugOrId` — Detail mit beiden Richtungen. */
  app.get<{ Params: { slugOrId: string } }>(
    '/api/content/concepts/:slugOrId',
    guard,
    async (request, reply) => {
      const found = await getConcept(db, request.params.slugOrId);
      if (found === undefined) {
        return fail(
          reply,
          404,
          'not_found',
          `Das Konzept "${request.params.slugOrId}" gibt es nicht.`,
        );
      }
      return reply.send(found);
    },
  );

  /* --------------------------------------------------------------------
   * Charts
   * ------------------------------------------------------------------ */

  /** `GET /api/content/charts` — Metadaten, **ohne** Matrizen. */
  app.get<{ Querystring: { chapter?: string; concept?: string; includeUnapproved?: string } }>(
    '/api/content/charts',
    guard,
    async (request, reply) => {
      const chapter = pickNumber(request.query.chapter);
      if (chapter === 'invalid') {
        return fail(reply, 400, 'invalid_request', '"chapter" muss eine Zahl sein.');
      }
      return reply.send(
        await listCharts(db, {
          chapter,
          concept: request.query.concept,
          includeUnapproved: request.query.includeUnapproved === 'true',
        }),
      );
    },
  );

  /**
   * `GET /api/content/spots` — Spot-Suche.
   *
   * Steht **vor** `/charts/:id`? Nein — eigener Pfad, keine Kollision. Die
   * Suche liegt bewusst nicht unter `/charts`, weil sie eine eigene Frage
   * beantwortet: nicht „welches Chart ist das", sondern „welches passt hier".
   */
  app.get<{
    Querystring: {
      position?: string;
      vs?: string;
      stack?: string;
      tolerance?: string;
      action?: string;
      format?: string;
      limit?: string;
      includeUnapproved?: string;
    };
  }>('/api/content/spots', guard, async (request, reply) => {
    const hero = pickFrom<ChartPosition>(request.query.position, CHART_POSITIONS);
    if (!hero.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekannte Position.', hero.allowed);
    }
    const villain = pickFrom<ChartPosition>(request.query.vs, CHART_POSITIONS);
    if (!villain.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekannte Gegenposition.', villain.allowed);
    }
    const format = pickFrom<ChartFormat>(request.query.format, CHART_FORMATS);
    if (!format.ok) {
      return fail(reply, 400, 'invalid_request', 'Unbekannte Spielform.', format.allowed);
    }

    const stack = pickNumber(request.query.stack);
    if (stack === 'invalid') {
      return fail(reply, 400, 'invalid_request', '"stack" muss eine Zahl sein.');
    }
    const tolerance = pickNumber(request.query.tolerance);
    if (tolerance === 'invalid' || (typeof tolerance === 'number' && tolerance < 0)) {
      return fail(reply, 400, 'invalid_request', '"tolerance" muss eine Zahl ≥ 0 sein.');
    }
    const limit = pickNumber(request.query.limit);
    if (limit === 'invalid') {
      return fail(reply, 400, 'invalid_request', '"limit" muss eine Zahl sein.');
    }

    return reply.send(
      await searchSpots(
        db,
        {
          heroPosition: hero.value,
          villainPosition: villain.value,
          stackDepthBb: stack,
          stackToleranceBb: tolerance ?? SPOT_STACK_TOLERANCE_BB,
          action: request.query.action,
          format: format.value,
        },
        {
          includeUnapproved: request.query.includeUnapproved === 'true',
          ...(limit === undefined ? {} : { limit }),
        },
      ),
    );
  });

  /** `GET /api/content/charts/:id` — vollständige Matrix. */
  app.get<{ Params: { id: string }; Querystring: { includeUnapproved?: string } }>(
    '/api/content/charts/:id',
    guard,
    async (request, reply) => {
      const chart = await getChart(
        db,
        request.params.id,
        request.query.includeUnapproved === 'true',
      );
      if (chart === undefined) {
        return fail(
          reply,
          404,
          'not_found',
          `Kein freigegebenes Chart mit der ID "${request.params.id}". Nicht freigegebene ` +
            `Charts sind nur mit includeUnapproved=true erreichbar.`,
        );
      }
      return reply.send(chart);
    },
  );

  /**
   * `GET /api/content/charts/:id/cells/:hand` — eine einzelne Zelle.
   *
   * Der Baustein für objektiv prüfbare Fragen: eine Zeile statt 169.
   */
  app.get<{ Params: { id: string; hand: string }; Querystring: { includeUnapproved?: string } }>(
    '/api/content/charts/:id/cells/:hand',
    guard,
    async (request, reply) => {
      const { hand } = request.params;
      if (!isChartHand(hand)) {
        return fail(
          reply,
          400,
          'invalid_request',
          `"${hand}" ist keine gültige Blattbezeichnung. Erwartet wird die Schreibweise ` +
            `des 13×13-Rasters, etwa AA, AKs oder AKo.`,
        );
      }
      const cell = await getCell(
        db,
        request.params.id,
        hand,
        request.query.includeUnapproved === 'true',
      );
      if (cell === undefined) {
        return fail(
          reply,
          404,
          'not_found',
          `Für ${hand} liegt in diesem Chart kein freigegebener Wert vor.`,
        );
      }
      return reply.send(cell);
    },
  );

  /* --------------------------------------------------------------------
   * Bilder
   * ------------------------------------------------------------------ */

  /**
   * `GET /api/content/assets/:assetId/image`
   *
   * Angefragt wird eine ID, nie ein Pfad. Mit Caching-Headern und ETag —
   * Buchbilder ändern sich nicht, und ein zweiter Abruf soll billig sein.
   */
  app.get<{ Params: { assetId: string } }>(
    '/api/content/assets/:assetId/image',
    guard,
    async (request, reply) => {
      const result = await loadAsset(db, request.params.assetId, options.sourceDir);

      if (isAssetProblem(result)) {
        switch (result.kind) {
          case 'unknown-asset':
            return fail(reply, 404, 'not_found', 'Dieses Asset gibt es nicht.');
          case 'unsupported-type':
            return fail(
              reply,
              400,
              'invalid_request',
              'Für dieses Asset ist kein Bildformat hinterlegt.',
            );
          case 'unsafe-path':
            // Der Pfad steht in der Datenbank und verlaesst trotzdem das
            // Bildverzeichnis - das ist ein Datenfehler, kein Nutzerfehler.
            request.log.error({ detail: result.detail }, 'Unsicherer Asset-Pfad abgewiesen.');
            return fail(reply, 400, 'invalid_request', 'Der hinterlegte Pfad ist nicht zulässig.');
          case 'file-missing':
            return fail(
              reply,
              404,
              'not_found',
              'Die Bilddatei liegt auf diesem Server nicht vor. Ist das Quellverzeichnis ' +
                'eingehängt (BOOK_SOURCE_DIR)?',
            );
        }
      }

      reply
        .header('content-type', result.mediaType)
        .header('cache-control', ASSET_CACHE_CONTROL)
        .header('etag', result.etag)
        .header('last-modified', result.lastModified)
        // Ein Zwischenspeicher darf die Antwort nicht ueber Sessions hinweg
        // wiederverwenden.
        .header('vary', 'Cookie');

      const seen = request.headers['if-none-match'];
      if (typeof seen === 'string' && seen.split(',').some((tag) => tag.trim() === result.etag)) {
        return reply.code(304).send();
      }

      return reply.send(result.data);
    },
  );
}
