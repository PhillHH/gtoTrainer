import type { FastifyInstance, FastifyReply } from 'fastify';
import { REVIEW_CONTEXTS, isReviewContext } from '@gto/shared';
import type {
  LearningEventErrorResponse,
  RecordLearningEventInput,
  RecordLearningEventResponse,
} from '@gto/shared';
import { sendAuthError } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { LearningEventValidationError, recordLearningEvent } from './service.js';
import { readConceptDetail, readDashboard, readQueuePreview, readRatingsOverview } from './read.js';

/**
 * Aussenschnittstelle des Lernstands (AP4.T4.2 und T4.7).
 *
 * **Genau ein schreibender Endpunkt** - und er ruft dieselbe Servicefunktion,
 * die auch der Job-Worker und spaetere Module intern benutzen. Es gibt keine
 * zweite Implementierung und keinen zweiten Weg in die abgeleiteten Tabellen.
 *
 * Dazu **vier lesende** (T4.7): Dashboard-Aggregat, Konzeptdetail,
 * Queue-Vorschau und Ratings-Verlauf. Sie reichen die Ergebnisse aus T4.3 bis
 * T4.6 durch und rechnen nichts neu.
 *
 * **Lesend heisst lesend.** Kein `GET` erzeugt ein Ereignis, verschiebt eine
 * Faelligkeit oder aktualisiert ein Rating.
 *
 * Auth: `app.requireSession` an **jeder** Route. CSRF: der globale Hook aus
 * T1.3 greift fuer jede zustandsaendernde Methode - bei den Lese-Endpunkten
 * also nicht, was richtig ist.
 */

export interface LearningRoutesOptions {
  readonly db: Database;
}

export function registerLearningRoutes(app: FastifyInstance, options: LearningRoutesOptions): void {
  const { db } = options;

  /** `POST /api/learning/events` - ein Ereignis aufzeichnen. */
  app.post<{ Body: RecordLearningEventInput }>(
    '/api/learning/events',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return sendAuthError(reply, 400, 'invalid_request', 'Der Rumpf muss ein Objekt sein.');
      }

      try {
        const result: RecordLearningEventResponse = await recordLearningEvent(db, body);
        // 201 fuer ein neu aufgezeichnetes Ereignis, 200 fuer eine Wiederholung.
        // Beides ist Erfolg - der Aufrufer unterscheidet ueber `status`.
        return reply.code(result.status === 'recorded' ? 201 : 200).send(result);
      } catch (error) {
        if (error instanceof LearningEventValidationError) {
          const payload: LearningEventErrorResponse = {
            error: 'invalid_event',
            message: 'Das Ereignis wurde abgelehnt.',
            fields: error.fields,
          };
          return reply.code(400).send(payload);
        }
        throw error;
      }
    },
  );

  /* --- Lesen (T4.7) ---------------------------------------------------- */

  /** `GET /api/learning/dashboard` - alles fuer die Startseite in einem Abruf. */
  app.get<{ Querystring: { asOf?: string } }>(
    '/api/learning/dashboard',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const asOf = parseAsOf(request.query.asOf);
      if (asOf === null) return badTimestamp(reply);
      return reply.send(await readDashboard(db, asOf));
    },
  );

  /** `GET /api/learning/concepts/:id` - "wie steht es um dieses Konzept?" */
  app.get<{ Params: { id: string }; Querystring: { asOf?: string } }>(
    '/api/learning/concepts/:id',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const asOf = parseAsOf(request.query.asOf);
      if (asOf === null) return badTimestamp(reply);

      const detail = await readConceptDetail(db, request.params.id, asOf);
      if (detail === null) {
        return sendAuthError(reply, 404, 'invalid_request', 'Konzept nicht gefunden.');
      }
      return reply.send(detail);
    },
  );

  /** `GET /api/learning/queue` - was jetzt faellig ist und was demnaechst kommt. */
  app.get<{
    Querystring: { context?: string; limit?: string; withinDays?: string; asOf?: string };
  }>('/api/learning/queue', { preHandler: app.requireSession }, async (request, reply) => {
    const asOf = parseAsOf(request.query.asOf);
    if (asOf === null) return badTimestamp(reply);

    const context = request.query.context;
    if (context !== undefined && !isReviewContext(context)) {
      return sendAuthError(
        reply,
        400,
        'invalid_request',
        `Unbekannter Kontext "${context}". Erlaubt: ${REVIEW_CONTEXTS.join(', ')}.`,
      );
    }

    const limit = parseCount(request.query.limit, 20);
    const withinDays = parseCount(request.query.withinDays, 14);
    if (limit === null || withinDays === null) {
      return sendAuthError(
        reply,
        400,
        'invalid_request',
        '"limit" und "withinDays" muessen ganze Zahlen ab 0 sein.',
      );
    }

    return reply.send(
      await readQueuePreview(db, {
        ...(context === undefined ? {} : { context }),
        limit,
        withinDays,
        asOf,
      }),
    );
  });

  /** `GET /api/learning/ratings` - Ratings mit Verlauf plus Level-Verlauf. */
  app.get<{ Querystring: { days?: string; asOf?: string } }>(
    '/api/learning/ratings',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const asOf = parseAsOf(request.query.asOf);
      if (asOf === null) return badTimestamp(reply);

      const days = parseCount(request.query.days, 90);
      if (days === null || days === 0) {
        return sendAuthError(reply, 400, 'invalid_request', '"days" muss eine Zahl ab 1 sein.');
      }

      return reply.send(await readRatingsOverview(db, { days, asOf }));
    },
  );
}

/**
 * Der Bezugszeitpunkt aus der Anfrage - **vorbelegt mit jetzt**.
 *
 * Innen ist `asOf` ein Pflichtparameter (Determinismus-Regel aus T4.2); die
 * Vorbelegung mit der aktuellen Zeit gehoert genau hierher, an die
 * HTTP-Grenze. `null` = unbrauchbarer Wert.
 */
function parseAsOf(raw: string | undefined): Date | null {
  if (raw === undefined || raw === '') return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Eine Zahl aus der Anfrage; `null` = unbrauchbar. */
function parseCount(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function badTimestamp(reply: FastifyReply): FastifyReply {
  return sendAuthError(reply, 400, 'invalid_request', '"asOf" ist kein gültiger ISO-Zeitstempel.');
}
