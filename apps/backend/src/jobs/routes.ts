import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_EVENT_NAME } from '@gto/shared';
import type { JobEvent, JobRetryResponse } from '@gto/shared';
import type { Database } from '../db/client.js';
import { sendAuthError } from '../auth/plugin.js';
import type { JobEventBus } from './events.js';
import { findJob, requeueDeadJob } from './queue.js';

/**
 * HTTP-Zugaenge zur Job-Queue (AP2.T2.5): der SSE-Statuskanal und das erneute
 * Einplanen eines Dead-Letter-Jobs.
 *
 * Beide Routen haengen an `app.requireSession` - dieselbe Zugriffsentscheidung
 * wie ueberall sonst, keine eigene Pruefung.
 */

export interface JobRoutesOptions {
  readonly db: Database;
  readonly events: JobEventBus;
  /**
   * Abstand der Keepalive-Kommentare. Ohne sie schliessen Proxys eine stille
   * Verbindung nach ihrem Lesetimeout.
   */
  readonly keepAliveMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 25_000;

export function registerJobRoutes(app: FastifyInstance, options: JobRoutesOptions): void {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
  /** Alle offenen Streams - werden beim Herunterfahren geschlossen. */
  const openStreams = new Set<() => void>();

  /**
   * `GET /api/jobs/events` - Statusaenderungen als Server-Sent Events.
   *
   * Aufraeumen ist hier das Wesentliche: Bei Verbindungsabbruch und beim
   * Herunterfahren wird der Zuhoerer abgemeldet und der Timer gestoppt. Sonst
   * waechst der Ereignisbus mit jeder verlorenen Verbindung weiter.
   */
  app.get(
    '/api/jobs/events',
    { preHandler: app.requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Falls doch einmal ein Proxy mit Puffer davorsteht: Nginx wertet das aus.
        'x-accel-buffering': 'no',
      });
      // Fastify soll die Antwort nicht selbst beenden.
      reply.hijack();

      let closed = false;
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          reply.raw.write(chunk);
        } catch {
          close();
        }
      };

      // Erste Zeile sofort, damit der Client die Verbindung als offen erkennt
      // und kein Puffer auf Inhalt wartet.
      write(': verbunden\n\n');

      const unsubscribe = options.events.subscribe((event: JobEvent) => {
        write(`event: ${JOB_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const keepAlive = setInterval(() => write(': keepalive\n\n'), keepAliveMs);
      keepAlive.unref?.();

      function close(): void {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        openStreams.delete(close);
        reply.raw.end();
      }

      openStreams.add(close);
      request.raw.on('close', close);
      request.raw.on('error', close);
    },
  );

  /**
   * `POST /api/jobs/:id/retry` - plant einen Dead-Letter-Job erneut ein.
   *
   * Damit ist eine behobene Ursache gleichbedeutend mit wiederholbarer Arbeit;
   * niemand muss den Job von Hand nachbauen.
   */
  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/retry',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const { id } = request.params;

      const requeued = await requeueDeadJob(options.db, id);
      if (requeued !== undefined) {
        const body: JobRetryResponse = {
          jobId: requeued.id,
          status: requeued.status,
          attempts: requeued.attempts,
        };
        options.events.publish({
          jobId: requeued.id,
          jobType: requeued.jobType,
          status: 'queued',
          attempts: requeued.attempts,
          maxAttempts: requeued.maxAttempts,
          at: new Date().toISOString(),
        });
        return reply.send(body);
      }

      // Nichts geaendert: Entweder gibt es den Job nicht, oder er ist nicht tot.
      const existing = await findJob(options.db, id);
      if (existing === undefined) {
        return sendAuthError(reply, 404, 'invalid_request', `Kein Job mit der Kennung "${id}".`);
      }
      return sendAuthError(
        reply,
        409,
        'invalid_request',
        `Job "${id}" steht auf "${existing.status}". Erneut einplanen laesst sich nur ein Job im Dead-Letter-Zustand.`,
      );
    },
  );

  // Beim Herunterfahren keine haengenden Verbindungen zuruecklassen.
  app.addHook('onClose', async () => {
    for (const close of [...openStreams]) close();
    options.events.clear();
  });
}
