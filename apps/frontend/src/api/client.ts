import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  JOB_EVENT_NAME,
  isAuthErrorResponse,
  isJobEvent,
  type AuthErrorCode,
  type CsrfTokenResponse,
  type JobEvent,
  type JobRetryResponse,
  type LlmCallDetailResponse,
  type LlmCallListResponse,
  type LlmCallStatus,
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

/** Fehlerarten, die der Aufrufer unterscheiden koennen muss. */
export type ApiErrorKind =
  'unauthenticated' | 'rate_limited' | 'csrf_failed' | 'client' | 'server' | 'network';

/** Einheitlicher Fehler aller API-Aufrufe. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** Fehlercode des Backends, falls die Antwort dem Auth-Vertrag entsprach. */
  readonly code: AuthErrorCode | undefined;

  constructor(kind: ApiErrorKind, status: number, message: string, code?: AuthErrorCode) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
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

export const apiClient = {
  fetchCsrfToken,
  login,
  logout,
  fetchMe,
  fetchLlmCalls,
  fetchLlmCall,
  retryJob,
  subscribeToJobEvents,
} as const;
