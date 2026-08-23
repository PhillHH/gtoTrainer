/**
 * Vertrag des LLM-Gateways (AP2.T2.1).
 *
 * `LLMProvider` ist der **einzige** erlaubte KI-Zugang im gesamten Projekt.
 * Alle Folge-Arbeitspakete (AP3 Vision, AP4 Reports, AP5 Didaktik,
 * AP8 Analyse, AP9 Material) rufen ausschliesslich ueber diesen Vertrag auf -
 * direkte CLI-Spawns oder HTTP-Aufrufe gegen die Anthropic-API ausserhalb der
 * Adapter sind unzulaessig.
 *
 * Hier stehen **nur Typen und Konstanten**. Die Adapter kommen in T2.2 (CLI)
 * und T2.3 (API).
 */

/* -------------------------------------------------------------------------
 * Provider-Kennung
 * ---------------------------------------------------------------------- */

/**
 * Geschlossene Menge der Provider. T2.3 (Umschaltung) und T2.6 (Settings-UI)
 * verwenden exakt diese Werte - auch als Wert der Spalte `llm_call_log.provider`.
 */
export const LLM_PROVIDER_IDS = ['cli', 'api'] as const;

/** `cli` = Claude Code CLI (Subscription), `api` = Anthropic Messages API. */
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

/** Laufzeitpruefung, z. B. fuer Werte aus der `config`-Tabelle oder der UI. */
export function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
 * Anfrage
 * ---------------------------------------------------------------------- */

/** Rollen im Gespraechsverlauf. Der System-Prompt ist ein eigenes Feld. */
export type LlmRole = 'user' | 'assistant';

/** Textbaustein einer Nachricht. */
export interface LlmTextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Bildformate, die als Base64 uebergeben werden duerfen.
 *
 * Bewusst geschlossen: AP3 liefert PNG-Renderings der Chart-Seiten, und ein
 * offener String wuerde erst beim Provider auffallen.
 */
export const LLM_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** Medientyp eines Bildbausteins. */
export type LlmImageMediaType = (typeof LLM_IMAGE_MEDIA_TYPES)[number];

/**
 * Bildbaustein einer Nachricht (Scope-Delta 3 der AP-Datei).
 *
 * AP3 wertet ueber denselben Provider rund 336 Chart-Bilder aus; das Interface
 * muss Bild-Input daher von Anfang an tragen und darf dort nicht brechen.
 */
export interface LlmImageContent {
  readonly type: 'image';
  readonly mediaType: LlmImageMediaType;
  /** Base64-kodierte Bilddaten - **ohne** `data:`-Praefix. */
  readonly data: string;
}

/** Ein Nachrichtenbaustein: Text oder Bild. */
export type LlmContent = LlmTextContent | LlmImageContent;

/** Eine Nachricht des Verlaufs. Der Inhalt ist immer eine Bausteinliste. */
export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: readonly LlmContent[];
}

/**
 * JSON-Schema fuer strukturierte Antworten. Bewusst nicht nachmodelliert -
 * beide Adapter reichen das Objekt unveraendert an den Provider durch.
 */
export type LlmJsonSchema = Readonly<Record<string, unknown>>;

/** Anfrage an einen Provider. */
export interface LlmRequest {
  /** System-Prompt / Persona. Die Personas selbst kommen aus T2.4. */
  readonly system: string;
  /** Gespraechsverlauf, mindestens eine Nachricht. */
  readonly messages: readonly LlmMessage[];
  /** Modellkennung, z. B. `opus` oder `claude-sonnet-5`. */
  readonly model: string;
  /** Obergrenze der Antwortlaenge in Tokens. */
  readonly maxTokens: number;
  /** Gesetzt = strukturierte Antwort erzwingen; `response.json` ist dann belegt. */
  readonly jsonSchema?: LlmJsonSchema;
  /** Harte Obergrenze fuer den Aufruf. Ohne Angabe gilt der Konfigurationswert. */
  readonly timeoutMs?: number;
}

/* -------------------------------------------------------------------------
 * Antwort
 * ---------------------------------------------------------------------- */

/**
 * Begleitdaten eines Aufrufs.
 *
 * Deckt genau die Spalten ab, die `llm_call_log` aus AP1 erwartet
 * (`provider`, `model`, `duration_ms`, `prompt_tokens`, `completion_tokens`,
 * `total_tokens`). Tokenzahlen sind `null`, wenn der Provider sie nicht
 * ausweist - die Spalten in der Tabelle sind ebenfalls nullable.
 */
export interface LlmCallMeta {
  readonly provider: LlmProviderId;
  /** Tatsaechlich verwendetes Modell, nicht der angefragte Alias. */
  readonly model: string;
  /** Wanduhrzeit des gesamten Aufrufs in Millisekunden. */
  readonly durationMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

/**
 * Antwort eines Providers.
 *
 * `text` ist immer belegt. `json` ist genau dann kein `null`, wenn die Anfrage
 * ein `jsonSchema` gesetzt hatte und die Antwort dagegen ausgewertet werden
 * konnte; andernfalls faellt ein Fehler der Kategorie `parse` an.
 */
export interface LlmResponse<TJson = unknown> {
  readonly text: string;
  readonly json: TJson | null;
  readonly meta: LlmCallMeta;
}

/* -------------------------------------------------------------------------
 * Fehler-Taxonomie
 * ---------------------------------------------------------------------- */

/**
 * Geschlossene Menge der Fehlerkategorien. Jeder Adapter bildet **jede**
 * Stoerung auf genau eine dieser Kategorien ab; es gibt keine Restklasse.
 *
 * - `timeout`     - der Aufruf hat `timeoutMs` ueberschritten und wurde abgebrochen.
 * - `rate_limit`  - Kontingent erschoepft (Subscription-Limit oder API-429).
 * - `auth`        - Anmeldung oder Konfiguration fehlt/ungueltig, z. B. fehlendes
 *                   `CLAUDE_CONFIG_DIR` oder "Not logged in".
 * - `transient`   - vorruebergehende Stoerung (Netz, 5xx, Prozessabbruch).
 * - `invalid`     - die Anfrage selbst ist fehlerhaft (Modell unbekannt,
 *                   ungueltiges JSON-Schema, zu langer Prompt).
 * - `parse`       - der Provider hat geantwortet, die Antwort ist aber nicht
 *                   auswertbar (kein JSON, Schema verfehlt).
 */
export const LLM_ERROR_KINDS = [
  'timeout',
  'rate_limit',
  'auth',
  'transient',
  'invalid',
  'parse',
] as const;

/** Eine der sechs Fehlerkategorien. */
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

/**
 * Retry-Faehigkeit je Kategorie - verbindlich fuer die Backoff-Logik in T2.2
 * und die Dead-Letter-Entscheidung in T2.5.
 *
 * Der `Record`-Typ erzwingt zur Uebersetzungszeit, dass jede Kategorie einen
 * Eintrag hat: eine neue Kategorie ohne Retry-Aussage kompiliert nicht.
 *
 * `rate_limit` gilt als retrybar, aber **nicht sofort**: Ein
 * Subscription-Limit setzt sich erst zur genannten Uhrzeit zurueck. Der
 * Wiederholungsversuch gehoert deshalb in die Job-Queue (grosses
 * `available_at`), nicht in den prozessinternen Backoff. Sofern der Provider
 * einen Zeitpunkt nennt, transportiert `retryAfterMs` ihn.
 */
export const LLM_ERROR_RETRYABLE: Readonly<Record<LlmErrorKind, boolean>> = {
  timeout: true,
  rate_limit: true,
  auth: false,
  transient: true,
  invalid: false,
  parse: false,
};

/** Ist diese Kategorie ueberhaupt wiederholbar? */
export function isLlmErrorRetryable(kind: LlmErrorKind): boolean {
  return LLM_ERROR_RETRYABLE[kind];
}

/** Laufzeitpruefung fuer Werte aus Logs, Jobs oder API-Antworten. */
export function isLlmErrorKind(value: unknown): value is LlmErrorKind {
  return typeof value === 'string' && (LLM_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Vertragliche Form eines Provider-Fehlers. Beide Adapter melden Stoerungen in
 * dieser Gestalt, damit Job-Worker und UI nicht zwischen Providern
 * unterscheiden muessen.
 */
export interface LlmErrorPayload {
  readonly kind: LlmErrorKind;
  readonly provider: LlmProviderId;
  /** Fuer Menschen lesbare Ursache; landet in `llm_call_log.error`. */
  readonly message: string;
  /** Fruehester sinnvoller Wiederholungszeitpunkt, falls der Provider ihn nennt. */
  readonly retryAfterMs?: number;
}

/* -------------------------------------------------------------------------
 * Der Vertrag
 * ---------------------------------------------------------------------- */

/**
 * Einziger KI-Zugang des Systems.
 *
 * Ein neuer Adapter dockt an, indem er dieses Interface implementiert und sich
 * unter einer `LlmProviderId` registrieren laesst - mehr nicht. Fehler wirft er
 * so, dass sie als `LlmErrorPayload` auswertbar sind.
 */
export interface LLMProvider {
  /** Kennung dieses Adapters; wird unveraendert nach `meta.provider` uebernommen. */
  readonly id: LlmProviderId;
  /** Fuehrt genau einen Aufruf aus. Zustandslos - kein Sitzungsverlauf. */
  complete<TJson = unknown>(request: LlmRequest): Promise<LlmResponse<TJson>>;
}
