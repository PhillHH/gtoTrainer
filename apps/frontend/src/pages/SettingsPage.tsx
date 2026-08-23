import { useCallback, useEffect, useState } from 'react';
import type { JobEvent, LlmCallDetail, LlmCallStatus, LlmCallSummary } from '@gto/shared';
import { apiClient } from '../api/client.js';
import './SettingsPage.css';

/**
 * Einstellungen mit der Ansicht "letzte KI-Aufrufe" (AP2.T2.5).
 *
 * Bewusst einfach: Liste, Statusfilter, Detailansicht. Sie zeigt, was das
 * LLM-Gateway tatsaechlich getan hat - inklusive der Fehlschlaege, denn genau
 * die braucht man bei der Fehlersuche.
 *
 * Die Wahl von Provider und Modell kommt in T2.6 auf dieselbe Seite.
 */

type Filter = 'alle' | LlmCallStatus;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'alle', label: 'Alle' },
  { value: 'success', label: 'Erfolg' },
  { value: 'error', label: 'Fehler' },
  { value: 'pending', label: 'Laufend' },
];

const STATUS_LABEL: Readonly<Record<LlmCallStatus, string>> = {
  pending: 'läuft',
  success: 'Erfolg',
  error: 'Fehler',
};

export function SettingsPage(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('alle');
  const [calls, setCalls] = useState<readonly LlmCallSummary[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LlmCallDetail | undefined>(undefined);
  const [lastEvent, setLastEvent] = useState<JobEvent | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await apiClient.fetchLlmCalls(
        filter === 'alle' ? { limit: 50 } : { status: filter, limit: 50 },
      );
      setCalls(response.calls);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Laeuft ein Job, aktualisiert der Statuskanal die Liste. Die Abmeldung beim
   * Verlassen der Seite ist wichtig - sonst bleibt die Verbindung offen.
   */
  useEffect(() => {
    return apiClient.subscribeToJobEvents((event) => {
      setLastEvent(event);
      // Ein abgeschlossener Job hat einen neuen Protokolleintrag erzeugt.
      if (event.status === 'done' || event.status === 'dead' || event.status === 'queued') {
        void load();
      }
    });
  }, [load]);

  const openDetail = async (id: string): Promise<void> => {
    try {
      const response = await apiClient.fetchLlmCall(id);
      setSelected(response.call);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
    }
  };

  return (
    <section>
      <h1>Einstellungen</h1>

      <div className="card">
        <div className="calls__header">
          <h2>Letzte KI-Aufrufe</h2>
          <div className="calls__filters" role="group" aria-label="Nach Status filtern">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={
                  filter === entry.value ? 'calls__filter calls__filter--active' : 'calls__filter'
                }
                aria-pressed={filter === entry.value}
                onClick={() => setFilter(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {lastEvent !== undefined && (
          <p className="muted" data-testid="job-status">
            Job {lastEvent.jobType}: {lastEvent.status}
          </p>
        )}

        {loadError !== undefined && (
          <p role="alert" className="calls__error">
            {loadError}
          </p>
        )}

        {loading && calls.length === 0 && <p className="muted">Wird geladen …</p>}

        {!loading && calls.length === 0 && loadError === undefined && (
          <p className="muted">Noch keine Aufrufe protokolliert.</p>
        )}

        {calls.length > 0 && (
          <table className="calls">
            <thead>
              <tr>
                <th scope="col">Zeitpunkt</th>
                <th scope="col">Provider</th>
                <th scope="col">Modell</th>
                <th scope="col">Dauer</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id}>
                  <td>{new Date(call.createdAt).toLocaleString('de-DE')}</td>
                  <td>{call.provider}</td>
                  <td>{call.model}</td>
                  <td>{call.durationMs === null ? '–' : `${call.durationMs} ms`}</td>
                  <td>
                    <span className={`badge badge--${call.status}`}>
                      {STATUS_LABEL[call.status]}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="calls__detail-button"
                      onClick={() => void openDetail(call.id)}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected !== undefined && (
        <div className="card" data-testid="call-detail">
          <div className="calls__header">
            <h2>Aufruf {selected.id.slice(0, 8)}</h2>
            <button type="button" onClick={() => setSelected(undefined)}>
              Schließen
            </button>
          </div>
          <p className="muted">
            {selected.provider} · {selected.model} ·{' '}
            {selected.durationMs === null ? 'ohne Dauer' : `${selected.durationMs} ms`} ·{' '}
            {selected.totalTokens === null ? 'ohne Tokenzahl' : `${selected.totalTokens} Tokens`}
          </p>
          {selected.error !== null && (
            <>
              <h3>Fehler</h3>
              <pre className="calls__text">{selected.error}</pre>
            </>
          )}
          <h3>Prompt</h3>
          <pre className="calls__text">{selected.prompt}</pre>
          <h3>Antwort</h3>
          <pre className="calls__text">{selected.response ?? '(noch keine Antwort)'}</pre>
        </div>
      )}
    </section>
  );
}
