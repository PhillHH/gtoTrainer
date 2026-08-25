import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  JOB_EVENT_NAME,
  isAuthErrorResponse,
  isJobEvent,
  isChartErrorResponse,
  isConceptErrorResponse,
  isLlmSettingsErrorResponse,
  type AuthErrorCode,
  type ConceptApproveResponse,
  type ConceptListResponse,
  type ConceptUpdate,
  type ConceptUpdateResponse,
  type ChartApproveResponse,
  type ChartCellUpdateRequest,
  type ReviewChartDetail,
  type ReviewListResponse,
  type CsrfTokenResponse,
  type JobEvent,
  type JobRetryResponse,
  type LlmCallDetailResponse,
  type LlmCallListResponse,
  type LlmCallStatus,
  type LlmPingRequest,
  type LlmPingResponse,
  type LlmSettingsResponse,
  type LlmSettingsUpdate,
  type LoginRequest,
  type LoginResponse,
  type LogoutResponse,
  type MeResponse,
} from '@gto/shared';

/**
 * DIE einzige Stelle im Frontend, die das Backend aufruft.
 *
 * Kein anderes Modul verwendet `fetch` direkt. Wer einen neuen Endpunkt
 * braucht, ergaenzt hier eine Funktion - so bleiben Cookie-Handling,
 * CSRF-Ablauf und Fehlerauswertung an einem Ort.
 *
 * Der CSRF-Ablauf folgt exakt docs/INTERFACES.md, Abschnitt 2a:
 *   1. `GET /api/auth/csrf` setzt das lesbare Cookie `gto_csrf`.
 *   2. Zustandsaendernde Requests spiegeln den Wert in `x-csrf-token`.
 *   3. Alles mit `credentials: 'include'`.
 */

/**
 * Basis-URL des Backends. Leer bedeutet "gleicher Origin" - im Dev-Betrieb
 * leitet der Vite-Proxy `/api` an das Backend weiter, im Zielbetrieb (T1.5)
 * uebernimmt das der Host-Nginx. Ueberschreibbar via `VITE_API_BASE_URL`.
 */
export const API_BASE_URL: string = import.meta.env['VITE_API_BASE_URL'] ?? '';

/** Methoden, die laut Vertrag ein CSRF-Token brauchen. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Feldweise Begruendung einer Ablehnung. */
export interface ApiFieldError {
  readonly field: string;
  readonly message: string;
}

/** Fehlerarten, die der Aufrufer unterscheiden koennen muss. */
export type ApiErrorKind =
  'unauthenticated' | 'rate_limited' | 'csrf_failed' | 'client' | 'server' | 'network';

/** Einheitlicher Fehler aller API-Aufrufe. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** Fehlercode des Backends, falls die Antwort dem Auth-Vertrag entsprach. */
  readonly code: AuthErrorCode | undefined;
  /**
   * Feldweise Ablehnungen: Einstellungen (AP2.T2.6) und Konzept-Review
   * (AP3.T3.2) melden beide nach diesem Muster. Leer bei allen anderen
   * Fehlern - die Oberflaeche zeigt sie am jeweiligen Feld an.
   *
   * Bewusst `string` statt `keyof LlmSettings`: Der Typ traegt inzwischen die
   * Feldnamen mehrerer Verträge. `SettingsFieldError` bleibt zuweisbar.
   */
  readonly fields: readonly ApiFieldError[];

  constructor(
    kind: ApiErrorKind,
    status: number,
    message: string,
    code?: AuthErrorCode,
    fields: readonly ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Liest ein Cookie aus `document.cookie`. */
function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return hit ? decodeURIComponent(hit.slice(prefix.length)) : undefined;
}

/** Ordnet einen HTTP-Status der passenden Fehlerart zu. */
function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'csrf_failed';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server' : 'client';
}

/** Verstaendliche Standardtexte je Fehlerart. */
function fallbackMessage(kind: ApiErrorKind): string {
  switch (kind) {
    case 'unauthenticated':
      return 'Die Sitzung ist abgelaufen. Bitte erneut anmelden.';
    case 'rate_limited':
      return 'Zu viele Versuche. Bitte kurz warten und es dann erneut versuchen.';
    case 'csrf_failed':
      return 'Die Sicherheitspruefung ist fehlgeschlagen. Bitte die Seite neu laden.';
    case 'server':
      return 'Der Server hat einen Fehler gemeldet. Bitte spaeter erneut versuchen.';
    case 'network':
      return 'Das Backend ist nicht erreichbar. Laeuft der Server?';
    case 'client':
      return 'Die Anfrage konnte nicht verarbeitet werden.';
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /**
   * Erlaubt es, das Nachholen des CSRF-Tokens zu unterdruecken - verhindert
   * eine Endlosschleife, falls `/api/auth/csrf` selbst scheitert.
   */
  readonly skipCsrfBootstrap?: boolean;
}

/** Fuehrt einen Request aus und wertet die Antwort typisiert aus. */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (STATE_CHANGING.has(method)) {
    let token = readCookie(CSRF_COOKIE_NAME);
    if (!token && !options.skipCsrfBootstrap) {
      // Noch kein Token vorhanden -> einmalig beschaffen (Vertrag Schritt 1).
      await fetchCsrfToken();
      token = readCookie(CSRF_COOKIE_NAME);
    }
    if (token) headers[CSRF_HEADER_NAME] = token;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      // Ohne dies wuerde das HttpOnly-Session-Cookie nicht mitgesendet.
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError('network', 0, fallbackMessage('network'));
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const kind = kindForStatus(response.status);
    if (isLlmSettingsErrorResponse(payload)) {
      throw new ApiError(kind, response.status, payload.message, undefined, payload.fields);
    }
    // Die Review-Ansicht des Konzept-Graphen (AP3.T3.2) lehnt nach demselben
    // Muster feldweise ab - dieselbe Auswertung, anderer Fehlercode.
    if (isConceptErrorResponse(payload)) {
      throw new ApiError(kind, response.status, payload.message, undefined, payload.fields);
    }
    // Die Review-Ansicht der Chart-Validierung (AP3.T3.4) lehnt nach demselben
    // Muster feldweise ab.
    if (isChartErrorResponse(payload)) {
      throw new ApiError(kind, response.status, payload.message, undefined, payload.fields);
    }
    if (isAuthErrorResponse(payload)) {
      throw new ApiError(kind, response.status, payload.message, payload.error);
    }
    throw new ApiError(kind, response.status, fallbackMessage(kind));
  }

  return payload as T;
}

/** Holt ein CSRF-Token; der Server setzt dabei das Cookie `gto_csrf`. */
export function fetchCsrfToken(): Promise<CsrfTokenResponse> {
  return request<CsrfTokenResponse>('/api/auth/csrf', { skipCsrfBootstrap: true });
}

/** Meldet an. Wirft `ApiError` mit `kind: 'rate_limited'` bei 429. */
export function login(credentials: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', { method: 'POST', body: credentials });
}

/** Meldet ab. */
export function logout(): Promise<LogoutResponse> {
  return request<LogoutResponse>('/api/auth/logout', { method: 'POST' });
}

/** Liest den angemeldeten Benutzer. Wirft bei fehlender Session 401. */
export function fetchMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me');
}

/* -------------------------------------------------------------------------
 * LLM-Gateway: Aufruf-Protokoll und Job-Status (AP2.T2.5)
 * ---------------------------------------------------------------------- */

/** Liest die letzten Protokolleintraege, optional nach Status gefiltert. */
export function fetchLlmCalls(
  options: { status?: LlmCallStatus; limit?: number } = {},
): Promise<LlmCallListResponse> {
  const query = new URLSearchParams();
  if (options.status !== undefined) query.set('status', options.status);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<LlmCallListResponse>(`/api/llm/calls${suffix}`);
}

/** Liest einen Protokolleintrag samt Prompt und Antwort. */
export function fetchLlmCall(id: string): Promise<LlmCallDetailResponse> {
  return request<LlmCallDetailResponse>(`/api/llm/calls/${encodeURIComponent(id)}`);
}

/** Plant einen Dead-Letter-Job erneut ein. */
export function retryJob(id: string): Promise<JobRetryResponse> {
  return request<JobRetryResponse>(`/api/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
}

/**
 * Abonniert den Statuskanal der Job-Queue.
 *
 * `EventSource` schickt Cookies bei `withCredentials` mit - denselben Weg
 * nutzt der Rest des Clients. Gibt es `EventSource` nicht (Testumgebung),
 * passiert nichts und der Aufrufer bekommt eine leere Abmeldung zurueck.
 */
export function subscribeToJobEvents(onEvent: (event: JobEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;

  const source = new EventSource(`${API_BASE_URL}/api/jobs/events`, { withCredentials: true });
  const handler = (message: MessageEvent<string>): void => {
    try {
      const parsed: unknown = JSON.parse(message.data);
      if (isJobEvent(parsed)) onEvent(parsed);
    } catch {
      // Eine unlesbare Zeile darf die Oberflaeche nicht stoeren.
    }
  };

  source.addEventListener(JOB_EVENT_NAME, handler as EventListener);
  return () => {
    source.removeEventListener(JOB_EVENT_NAME, handler as EventListener);
    source.close();
  };
}

/* -------------------------------------------------------------------------
 * Provider- und Modell-Einstellungen (AP2.T2.6)
 * ---------------------------------------------------------------------- */

/** Liest die geltenden Einstellungen samt Herkunft, Auswahl und Grenzen. */
export function fetchLlmSettings(): Promise<LlmSettingsResponse> {
  return request<LlmSettingsResponse>('/api/llm/settings');
}

/**
 * Speichert Einstellungen. Bei serverseitiger Ablehnung wirft der Aufruf
 * einen `ApiError` mit `kind: 'client'`; die Feldfehler stehen in `fields`.
 */
export function saveLlmSettings(patch: LlmSettingsUpdate): Promise<LlmSettingsResponse> {
  return request<LlmSettingsResponse>('/api/llm/settings', { method: 'PUT', body: patch });
}

/**
 * Setzt einen echten Testaufruf ab. Das kostet Kontingent bzw. Guthaben -
 * deshalb nur auf ausdrueckliche Aktion, nie beim Laden der Seite.
 */
export function pingLlm(body: LlmPingRequest = {}): Promise<LlmPingResponse> {
  return request<LlmPingResponse>('/api/llm/settings/ping', { method: 'POST', body });
}

/* -------------------------------------------------------------------------
 * Konzept-Graph: Review-Ansicht (AP3.T3.2)
 * ---------------------------------------------------------------------- */

/** Liest alle Konzepte nach Kapitel gruppiert, samt Auffaelligkeiten. */
export function fetchConcepts(): Promise<ConceptListResponse> {
  return request<ConceptListResponse>('/api/concepts');
}

/**
 * Aendert ein Konzept. Bei serverseitiger Ablehnung wirft der Aufruf einen
 * `ApiError`; die feldweisen Begruendungen stehen in `fields`.
 */
export function updateConcept(id: string, patch: ConceptUpdate): Promise<ConceptUpdateResponse> {
  return request<ConceptUpdateResponse>(`/api/concepts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** Bestaetigt ein einzelnes Konzept (draft -> approved). */
export function approveConcept(id: string): Promise<ConceptApproveResponse> {
  return request<ConceptApproveResponse>(`/api/concepts/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
  });
}

/** Bestaetigt alle offenen Konzepte eines Kapitels. */
export function approveChapter(chapterNumber: number): Promise<ConceptApproveResponse> {
  return request<ConceptApproveResponse>(`/api/concepts/chapters/${chapterNumber}/approve`, {
    method: 'POST',
  });
}

/* -------------------------------------------------------------------------
 * Chart-Validierung: Review-Ansicht (AP3.T3.4)
 * ---------------------------------------------------------------------- */

/** Liste aller digitalisierten Charts samt Zustand und Befundzahlen. */
export function fetchCharts(): Promise<ReviewListResponse> {
  return request<ReviewListResponse>('/api/charts');
}

/** Ein Chart mit Matrix, Befunden und Bild-URL. */
export function fetchChart(id: string): Promise<ReviewChartDetail> {
  return request<ReviewChartDetail>(`/api/charts/${encodeURIComponent(id)}`);
}

/**
 * Korrigiert einzelne Zellen von Hand.
 *
 * Die Korrektur startet serverseitig die Pruefung neu - die Antwort traegt
 * daher schon den neuen Zustand und die verbliebenen Befunde.
 */
export function correctChartCells(
  id: string,
  body: ChartCellUpdateRequest,
): Promise<ReviewChartDetail> {
  return request<ReviewChartDetail>(`/api/charts/${encodeURIComponent(id)}/cells`, {
    method: 'PATCH',
    body,
  });
}

/** Gibt ein einzelnes Chart frei. Scheitert, solange Fehlerbefunde offen sind. */
export function approveChart(id: string): Promise<ChartApproveResponse> {
  return request<ChartApproveResponse>(`/api/charts/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
  });
}

/** Gibt alle Charts im Zustand `validated` frei. */
export function approveValidatedCharts(): Promise<ChartApproveResponse> {
  return request<ChartApproveResponse>('/api/charts/approve-validated', { method: 'POST' });
}

/** Verwirft ein Chart mit Begruendung - der dokumentierte Rest. */
export function markChartUnusable(id: string, reason: string): Promise<ReviewChartDetail> {
  return request<ReviewChartDetail>(`/api/charts/${encodeURIComponent(id)}/unusable`, {
    method: 'POST',
    body: { reason },
  });
}

export const apiClient = {
  fetchCsrfToken,
  login,
  logout,
  fetchMe,
  fetchLlmCalls,
  fetchLlmCall,
  retryJob,
  subscribeToJobEvents,
  fetchLlmSettings,
  saveLlmSettings,
  pingLlm,
  fetchConcepts,
  updateConcept,
  approveConcept,
  approveChapter,
  fetchCharts,
  fetchChart,
  correctChartCells,
  approveChart,
  approveValidatedCharts,
  markChartUnusable,
} as const;
