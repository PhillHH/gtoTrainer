import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LLM_MODEL_CHOICES,
  LLM_PING_PROMPT,
  LLM_SETTINGS_RANGES,
  isLlmProviderId,
} from '@gto/shared';
import type {
  LlmPingRequest,
  LlmPingResponse,
  LlmSettingsErrorResponse,
  LlmSettingsResponse,
  LlmSettingsUpdate,
} from '@gto/shared';
import { desc } from 'drizzle-orm';
import { sendAuthError } from '../auth/plugin.js';
import type { LlmConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { llmCallLog } from '../db/schema.js';
import { isLlmError } from './errors.js';
import type { LlmProviderRegistry } from './registry.js';
import { SettingsValidationError, resolveSettings, writeSettings } from './settings.js';

/**
 * Einstellungen und Ping-Test (AP2.T2.6).
 *
 * Alle drei Routen haengen an `app.requireSession`; die beiden schreibenden
 * sind ueber den globalen CSRF-Hook aus T1.3 abgesichert. Der Ping geht
 * denselben Weg wie jeder andere Aufruf - ueber die Provider-Registry -, damit
 * Protokoll und Fehlerbehandlung aus T2.5 automatisch greifen.
 */

export interface SettingsRoutesOptions {
  readonly db: Database;
  readonly providers: LlmProviderRegistry;
  /** Defaults fuer nicht gesetzte Werte. */
  readonly fallback: LlmConfig;
  /** Mindestabstand zwischen zwei Ping-Tests. */
  readonly pingCooldownMs?: number;
  /** Nur fuer Tests: ersetzt `Date.now`. */
  readonly now?: () => number;
}

/**
 * Ein Ping kostet echtes Kontingent. Zehn Sekunden Abstand reichen gegen einen
 * haengenden Button, ohne beim Ausprobieren zu stoeren.
 */
const DEFAULT_PING_COOLDOWN_MS = 10_000;

/**
 * Token-Grenze des Pings.
 *
 * Erwartet wird "OK" - der Prompt ist winzig. Trotzdem nicht zu knapp: Die
 * Claude CLI **kuerzt nicht**, sie bricht ab, wenn die Antwort das Limit
 * sprengt (T2.2). Mit 64 Tokens scheitert schon ein normaler Einwortsatz samt
 * innerem Ueberlegen; 1024 laesst Luft und kostet dennoch fast nichts.
 */
const PING_MAX_TOKENS = 1024;

export function registerLlmSettingsRoutes(
  app: FastifyInstance,
  options: SettingsRoutesOptions,
): void {
  const cooldownMs = options.pingCooldownMs ?? DEFAULT_PING_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());
  let lastPingAt = 0;

  /** `GET /api/llm/settings` - geltende Werte samt Herkunft und Grenzen. */
  app.get(
    '/api/llm/settings',
    { preHandler: app.requireSession },
    async (_request, reply: FastifyReply) => {
      const resolved = await resolveSettings(options.db, options.fallback);
      const body: LlmSettingsResponse = {
        settings: resolved.settings,
        origin: resolved.origin,
        modelChoices: LLM_MODEL_CHOICES.map((choice) => ({ id: choice.id, label: choice.label })),
        ranges: LLM_SETTINGS_RANGES,
        // Nur ja/nein. Der Schluessel selbst verlaesst den Server nie.
        apiKeyConfigured: options.fallback.apiKey !== undefined && options.fallback.apiKey !== '',
      };
      return reply.send(body);
    },
  );

  /** `PUT /api/llm/settings` - schreibt nach serverseitiger Pruefung. */
  app.put<{ Body: LlmSettingsUpdate }>(
    '/api/llm/settings',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const patch = request.body;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return sendAuthError(reply, 400, 'invalid_request', 'Der Rumpf muss ein Objekt sein.');
      }

      try {
        const resolved = await writeSettings(options.db, patch, options.fallback);
        const body: LlmSettingsResponse = {
          settings: resolved.settings,
          origin: resolved.origin,
          modelChoices: LLM_MODEL_CHOICES.map((choice) => ({ id: choice.id, label: choice.label })),
          ranges: LLM_SETTINGS_RANGES,
          apiKeyConfigured: options.fallback.apiKey !== undefined && options.fallback.apiKey !== '',
        };
        return reply.send(body);
      } catch (error) {
        if (!(error instanceof SettingsValidationError)) throw error;
        // Feldweise Rueckmeldung, damit die Oberflaeche den Fehler am Feld
        // anzeigen kann statt als pauschale Meldung.
        const body: LlmSettingsErrorResponse = {
          error: 'invalid_settings',
          message: error.message,
          fields: error.fields,
        };
        return reply.code(400).send(body);
      }
    },
  );

  /**
   * `POST /api/llm/settings/ping` - ein minimaler echter Aufruf.
   *
   * Optional gegen einen anderen Provider als den gespeicherten; das ist ein
   * ausdruecklicher Parameter, kein versteckter Nebeneffekt, und aendert die
   * gespeicherte Wahl **nicht**.
   */
  app.post<{ Body: LlmPingRequest | undefined }>(
    '/api/llm/settings/ping',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const wanted = request.body?.provider;
      if (wanted !== undefined && !isLlmProviderId(wanted)) {
        return sendAuthError(
          reply,
          400,
          'invalid_request',
          `Unbekannter Provider "${String(wanted)}". Erlaubt sind "cli" und "api".`,
        );
      }

      const since = now() - lastPingAt;
      if (since < cooldownMs) {
        return sendAuthError(
          reply,
          429,
          'rate_limited',
          `Ein Testaufruf verbraucht Kontingent. Bitte noch ${Math.ceil((cooldownMs - since) / 1000)} Sekunden warten.`,
        );
      }
      lastPingAt = now();

      const { settings } = await resolveSettings(options.db, options.fallback);
      const providerId = wanted ?? settings.provider;
      const startedAt = Date.now();

      try {
        // Derselbe Weg wie jeder andere Aufruf: ueber die Registry, damit das
        // Protokoll aus T2.5 automatisch greift.
        const provider =
          wanted === undefined
            ? await options.providers.getActive()
            : options.providers.get(wanted, {
                model: settings.model,
                timeoutMs: settings.timeoutMs,
                maxConcurrency: settings.maxConcurrency,
                maxAttempts: settings.maxAttempts,
              });

        const response = await provider.complete({
          system: 'Du bist ein Verbindungstest. Antworte mit genau einem Wort.',
          messages: [{ role: 'user', content: [{ type: 'text', text: LLM_PING_PROMPT }] }],
          model: settings.model,
          maxTokens: PING_MAX_TOKENS,
          timeoutMs: settings.timeoutMs,
        });

        const body: LlmPingResponse = {
          ok: true,
          provider: response.meta.provider,
          model: response.meta.model,
          durationMs: response.meta.durationMs,
          text: response.text.slice(0, 200),
          // Verweis auf den Protokolleintrag, den der Dekorator aus T2.5 eben
          // geschrieben hat - die Log-Ansicht kann direkt dorthin fuehren.
          callId: await newestCallId(options.db),
        };
        return reply.send(body);
      } catch (error) {
        const kind = isLlmError(error) ? error.kind : 'invalid';
        const body: LlmPingResponse = {
          ok: false,
          provider: providerId,
          kind,
          message: error instanceof Error ? error.message.slice(0, 400) : String(error),
          hint: hintFor(kind, providerId),
          durationMs: Date.now() - startedAt,
        };
        // Bewusst 200: Der Testaufruf selbst ist geglueckt, sein Ergebnis ist
        // "der Provider antwortet nicht". Die Oberflaeche stellt beides dar.
        return reply.send(body);
      }
    },
  );
}

/** Kennung des zuletzt geschriebenen Protokolleintrags. */
async function newestCallId(db: Database): Promise<string | null> {
  const rows = await db
    .select({ id: llmCallLog.id })
    .from(llmCallLog)
    .orderBy(desc(llmCallLog.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Klartext-Hinweis je Fehlerkategorie - was jetzt zu tun ist. */
function hintFor(kind: string, provider: string): string {
  switch (kind) {
    case 'auth':
      return provider === 'cli'
        ? 'Profil B ist nicht eingeloggt oder der Host-Runner laeuft nicht. Siehe RUNBOOK 9.1 und 9.2.'
        : 'Es ist kein gueltiger ANTHROPIC_API_KEY hinterlegt. Siehe RUNBOOK 9.5.';
    case 'rate_limit':
      return 'Das Kontingent ist erschoepft. Bis zur genannten Uhrzeit warten oder auf den anderen Provider umschalten.';
    case 'timeout':
      return 'Der Aufruf hat zu lange gedauert. Timeout erhoehen oder ein kleineres Modell waehlen.';
    case 'transient':
      return 'Eine voruebergehende Stoerung. In einer Minute erneut versuchen.';
    case 'parse':
      return 'Die Antwort war nicht auswertbar. Das deutet auf ein Problem mit dem Modell oder dem Prompt hin.';
    default:
      return 'Die Anfrage wurde abgelehnt. Details stehen in der Meldung und im Aufruf-Protokoll unten.';
  }
}
