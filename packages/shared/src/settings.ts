import type { LlmProviderId } from './llm.js';

/**
 * Vertrag der Laufzeit-Einstellungen des LLM-Gateways (AP2.T2.6).
 *
 * Diese Werte liegen in der `config`-Tabelle und werden ueber die Oberflaeche
 * unter Einstellungen gesetzt. Sie wirken **ab dem naechsten Aufruf**, ohne
 * Neustart. Fachliche Einstellungen (Lernschwellen, Timer) gehoeren nicht
 * hierher - hier geht es ausschliesslich um Provider, Modell und die
 * Aufrufparameter.
 */

/** Zur Auswahl stehende Modelle. Bewusst kurz gehalten statt Freitext. */
export const LLM_MODEL_CHOICES = [
  { id: 'claude-opus-5', label: 'Opus 5 - staerkstes Modell, teuerste Aufrufe' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 - Standard fuer die meisten Aufgaben' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 - schnell und guenstig, fuer einfache Aufgaben' },
] as const;

/** Erlaubte Modellkennungen. */
export type LlmModelId = (typeof LLM_MODEL_CHOICES)[number]['id'];

export const LLM_MODEL_IDS: readonly LlmModelId[] = LLM_MODEL_CHOICES.map((choice) => choice.id);

export function isLlmModelId(value: unknown): value is LlmModelId {
  return typeof value === 'string' && (LLM_MODEL_IDS as readonly string[]).includes(value);
}

/** Zulaessige Spanne je Zahlenfeld - Grundlage der serverseitigen Pruefung. */
export const LLM_SETTINGS_RANGES = {
  /** Ein Vision-Aufruf aus AP3 braucht deutlich mehr als ein Textaufruf. */
  timeoutMs: { min: 5_000, max: 600_000 },
  /** Der Host ist geteilt; mehr als eine Handvoll CLI-Prozesse waere unfair. */
  maxConcurrency: { min: 1, max: 8 },
  /** Mehr Versuche verbrennen bei echter Stoerung nur Kontingent. */
  maxAttempts: { min: 1, max: 10 },
} as const;

/** Die vollstaendigen Einstellungen - so, wie sie tatsaechlich gelten. */
export interface LlmSettings {
  readonly provider: LlmProviderId;
  readonly model: LlmModelId;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly maxAttempts: number;
}

/** Alle Felder sind einzeln setzbar; was fehlt, bleibt unveraendert. */
export type LlmSettingsUpdate = Partial<LlmSettings>;

/** Woher ein geltender Wert stammt - die Oberflaeche zeigt das an. */
export type SettingsOrigin = 'config' | 'default';

/** Antwort von `GET /api/llm/settings`. */
export interface LlmSettingsResponse {
  /** Die geltenden Werte, Lücken mit Defaults aufgefüllt. */
  readonly settings: LlmSettings;
  /** Je Feld: stammt der Wert aus der Tabelle oder aus dem Default? */
  readonly origin: Readonly<Record<keyof LlmSettings, SettingsOrigin>>;
  /** Zur Auswahl stehende Modelle - die UI muss nichts hartkodieren. */
  readonly modelChoices: readonly { readonly id: string; readonly label: string }[];
  /** Grenzen der Zahlenfelder, damit die UI sie anzeigen kann. */
  readonly ranges: typeof LLM_SETTINGS_RANGES;
  /**
   * Ist ein Anthropic-API-Schluessel hinterlegt? Nur ja/nein - der Schluessel
   * selbst verlaesst den Server nie, auch nicht maskiert.
   */
  readonly apiKeyConfigured: boolean;
}

/** Ein abgelehntes Feld samt Grund. */
export interface SettingsFieldError {
  readonly field: keyof LlmSettings;
  readonly message: string;
}

/** Antwort bei fehlgeschlagener Validierung (HTTP 400). */
export interface LlmSettingsErrorResponse {
  readonly error: 'invalid_settings';
  readonly message: string;
  readonly fields: readonly SettingsFieldError[];
}

export function isLlmSettingsErrorResponse(value: unknown): value is LlmSettingsErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate['error'] === 'invalid_settings' && Array.isArray(candidate['fields']);
}

/* -------------------------------------------------------------------------
 * Ping-Test
 * ---------------------------------------------------------------------- */

/** Anfrage an `POST /api/llm/settings/ping`. */
export interface LlmPingRequest {
  /**
   * Optional gegen einen **anderen** Provider als den gespeicherten testen -
   * etwa um den Fallback zu pruefen, ohne die aktive Einstellung zu aendern.
   * Ohne Angabe gilt die gespeicherte Wahl.
   */
  readonly provider?: LlmProviderId;
}

/** Erfolgreicher Ping. */
export interface LlmPingSuccess {
  readonly ok: true;
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  /** Antworttext, gekuerzt. */
  readonly text: string;
  /** Verweis auf den Protokolleintrag, damit die Log-Ansicht dorthin fuehrt. */
  readonly callId: string | null;
}

/** Fehlgeschlagener Ping - mit Kategorie aus der Taxonomie. */
export interface LlmPingFailure {
  readonly ok: false;
  readonly provider: string;
  /** Kategorie aus der Fehler-Taxonomie, z. B. `auth` oder `rate_limit`. */
  readonly kind: string;
  /** Fuer Menschen lesbare Ursache. */
  readonly message: string;
  /** Was jetzt zu tun ist. */
  readonly hint: string;
  readonly durationMs: number;
}

export type LlmPingResponse = LlmPingSuccess | LlmPingFailure;

/** Der Prompt des Ping-Tests. Bewusst winzig - er kostet echtes Kontingent. */
export const LLM_PING_PROMPT = 'Antworte nur mit OK';
