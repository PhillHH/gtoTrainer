import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isLlmCallStatus } from '@gto/shared';
import type {
  LlmCallDetail,
  LlmCallDetailResponse,
  LlmCallListResponse,
  LlmCallStatus,
  LlmCallSummary,
} from '@gto/shared';
import { sendAuthError } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { llmCallLog } from '../db/schema.js';

/**
 * Lesezugriff auf `llm_call_log` (AP2.T2.5).
 *
 * Speist die Ansicht "letzte KI-Aufrufe" unter Einstellungen. Bewusst nur
 * lesend: Eintraege entstehen ausschliesslich ueber den Protokoll-Dekorator
 * der Provider-Registry.
 */

export interface LlmLogRoutesOptions {
  readonly db: Database;
  /** Obergrenze fuer `limit`, damit die Liste nicht die Antwort sprengt. */
  readonly maxLimit?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 200;
/** Fehlermeldungen in der Liste werden gekuerzt - Details hat die Einzelansicht. */
const LIST_ERROR_CHARS = 300;

interface ListQuery {
  readonly status?: string;
  readonly limit?: string;
}

export function registerLlmLogRoutes(app: FastifyInstance, options: LlmLogRoutesOptions): void {
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;

  /** `GET /api/llm/calls?status=success|error|pending&limit=n` */
  app.get<{ Querystring: ListQuery }>(
    '/api/llm/calls',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const { status, limit } = request.query;

      if (status !== undefined && status !== '' && !isLlmCallStatus(status)) {
        return sendAuthError(
          reply,
          400,
          'invalid_request',
          `Unbekannter Status "${status}". Erlaubt sind: pending, success, error.`,
        );
      }

      const parsedLimit = limit === undefined ? DEFAULT_LIMIT : Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
        return sendAuthError(
          reply,
          400,
          'invalid_request',
          `"limit" muss eine ganze Zahl zwischen 1 und ${maxLimit} sein.`,
        );
      }

      const base = options.db
        .select({
          id: llmCallLog.id,
          provider: llmCallLog.provider,
          model: llmCallLog.model,
          status: llmCallLog.status,
          durationMs: llmCallLog.durationMs,
          totalTokens: llmCallLog.totalTokens,
          createdAt: llmCallLog.createdAt,
          error: llmCallLog.error,
        })
        .from(llmCallLog)
        .$dynamic();

      const rows = await (
        status === undefined || status === '' ? base : base.where(eq(llmCallLog.status, status))
      )
        .orderBy(desc(llmCallLog.createdAt))
        .limit(parsedLimit);

      const body: LlmCallListResponse = {
        calls: rows.map((row): LlmCallSummary => ({
          id: row.id,
          provider: row.provider,
          model: row.model,
          status: row.status as LlmCallStatus,
          durationMs: row.durationMs,
          totalTokens: row.totalTokens,
          createdAt: row.createdAt.toISOString(),
          error: row.error === null ? null : shorten(row.error, LIST_ERROR_CHARS),
        })),
      };
      return reply.send(body);
    },
  );

  /** `GET /api/llm/calls/:id` - mit Prompt und Antwort. */
  app.get<{ Params: { id: string } }>(
    '/api/llm/calls/:id',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const rows = await options.db
        .select()
        .from(llmCallLog)
        .where(eq(llmCallLog.id, request.params.id))
        .limit(1);

      const row = rows[0];
      if (row === undefined) {
        return sendAuthError(
          reply,
          404,
          'invalid_request',
          `Kein Protokolleintrag mit der Kennung "${request.params.id}".`,
        );
      }

      const call: LlmCallDetail = {
        id: row.id,
        provider: row.provider,
        model: row.model,
        status: row.status as LlmCallStatus,
        durationMs: row.durationMs,
        totalTokens: row.totalTokens,
        createdAt: row.createdAt.toISOString(),
        error: row.error,
        prompt: row.prompt,
        response: row.response,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
      };
      const body: LlmCallDetailResponse = { call };
      return reply.send(body);
    },
  );
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
