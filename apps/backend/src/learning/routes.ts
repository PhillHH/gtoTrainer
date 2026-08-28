import type { FastifyInstance } from 'fastify';
import type {
  LearningEventErrorResponse,
  RecordLearningEventInput,
  RecordLearningEventResponse,
} from '@gto/shared';
import { sendAuthError } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { LearningEventValidationError, recordLearningEvent } from './service.js';

/**
 * Aussenschnittstelle des Lernstands (AP4.T4.2).
 *
 * **Genau ein schreibender Endpunkt** - und er ruft dieselbe Servicefunktion,
 * die auch der Job-Worker und spaetere Module intern benutzen. Es gibt keine
 * zweite Implementierung und keinen zweiten Weg in die abgeleiteten Tabellen.
 *
 * Die Lese-Endpunkte fuer das Dashboard entstehen in T4.7 und sind hier
 * bewusst nicht vorweggenommen.
 *
 * Auth: `app.requireSession`. CSRF: der globale Hook aus T1.3 greift fuer
 * jede zustandsaendernde Methode, hier also automatisch.
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
}
