/**
 * Vertrag fuer den Healthcheck-Endpunkt GET /healthz.
 *
 * Dieser Typ ist der erste reale Vertrag im Monorepo: Das Backend typisiert
 * seine Antwort damit, der Backend-Test prueft die Antwort dagegen. Aenderungen
 * an /healthz muessen hier beginnen, nicht im Backend.
 */
export interface HealthResponse {
  /** Statuskennung des Dienstes. Aktuell existiert nur der Gutfall. */
  readonly status: 'ok';
}

/** Der einzige derzeit gueltige Health-Status. */
export const HEALTH_STATUS_OK = 'ok' as const;

/**
 * Type-Guard: prueft zur Laufzeit, ob ein unbekannter Wert dem
 * HealthResponse-Vertrag entspricht. Wird u. a. im Backend-Test genutzt,
 * damit der Vertrag nicht nur zur Compile-Zeit, sondern auch gegen echte
 * HTTP-Antworten geprueft wird.
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === HEALTH_STATUS_OK
  );
}
