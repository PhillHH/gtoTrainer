import { useCallback, useEffect, useState } from 'react';
import { CARD_RANKS, CHART_HANDS } from '@gto/shared';
import type { ChartFinding, ReviewChartDetail, ReviewListResponse } from '@gto/shared';
import { apiClient } from '../api/client.js';
import './ChartsPage.css';

/**
 * Review-Ansicht der Chart-Validierung (AP3.T3.4, Subtask 6).
 *
 * Links das Original-Bild, rechts das 13×13-Raster mit den digitalisierten
 * Werten. Ohne diese Gegenüberstellung ist eine Korrektur nicht möglich — man
 * müsste sonst raten, was im Bild steht.
 */

const CHECK_LABEL: Readonly<Record<string, string>> = {
  'frequency-sum': 'Frequenzsumme',
  'caption-match': 'Caption-Abgleich',
  plausibility: 'Plausibilität',
};

const STATE_LABEL: Readonly<Record<string, string>> = {
  raw: 'ungeprüft',
  validated: 'geprüft',
  approved: 'freigegeben',
  failed: 'gescheitert',
  unusable: 'unbrauchbar',
};

export function ChartsPage(): JSX.Element {
  const [list, setList] = useState<ReviewListResponse | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<ReviewChartDetail | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setList(await apiClient.fetchCharts());
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unbekannter Fehler.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId === undefined) {
      setDetail(undefined);
      return;
    }
    void (async () => {
      try {
        setDetail(await apiClient.fetchChart(selectedId));
        setError(undefined);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unbekannter Fehler.');
      }
    })();
  }, [selectedId]);

  const approveOne = async (id: string): Promise<void> => {
    try {
      await apiClient.approveChart(id);
      setNotice('Chart freigegeben.');
      await loadList();
      setDetail(await apiClient.fetchChart(id));
    } catch (caught) {
      const fields = (caught as { fields?: readonly { message: string }[] }).fields ?? [];
      setNotice(
        fields.length > 0
          ? fields.map((field) => field.message).join(' ')
          : caught instanceof Error
            ? caught.message
            : 'Freigabe fehlgeschlagen.',
      );
    }
  };

  const approveAll = async (): Promise<void> => {
    try {
      const result = await apiClient.approveValidatedCharts();
      setNotice(`${result.approved} geprüfte Charts freigegeben.`);
      await loadList();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Freigabe fehlgeschlagen.');
    }
  };

  return (
    <section className="charts">
      <header className="charts__header">
        <div>
          <h1>Charts prüfen</h1>
          <p className="charts__hint">
            Bild links, gelesene Werte rechts. Erst nach der Freigabe sind die Zahlen für den Rest
            des Tools sichtbar.
          </p>
        </div>
        <div className="charts__header-actions">
          <button type="button" onClick={() => void loadList()} disabled={loading}>
            Neu laden
          </button>
          <button
            type="button"
            onClick={() => void approveAll()}
            disabled={(list?.totals.validated ?? 0) === 0}
          >
            Alle geprüften freigeben
          </button>
        </div>
      </header>

      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {loading && !list ? <p>Charts werden geladen …</p> : null}

      {list ? (
        <>
          <p className="charts__totals">
            {list.totals.digitized} von {list.totals.handRangeAssets} Charts digitalisiert —{' '}
            {list.totals.raw} ungeprüft, {list.totals.validated} geprüft, {list.totals.approved}{' '}
            freigegeben, {list.totals.failed} gescheitert, {list.totals.unusable} unbrauchbar.
            Freigabequote {(list.totals.approvedShare * 100).toFixed(1)} % (Ziel 95 %).
          </p>

          <div className="charts__layout">
            <ul className="charts__list" aria-label="Charts">
              {list.charts.map((chart) => (
                <li key={chart.id}>
                  <button
                    type="button"
                    className={`charts__list-item${selectedId === chart.id ? ' charts__list-item--active' : ''}`}
                    onClick={() => setSelectedId(chart.id)}
                  >
                    <span className="charts__list-title">
                      {chart.captionNumber === null
                        ? 'ohne Nummer'
                        : `Hand Range ${chart.captionNumber}`}
                    </span>
                    <span className={`charts__state charts__state--${chart.state}`}>
                      {STATE_LABEL[chart.state] ?? chart.state}
                    </span>
                    {chart.errorCount > 0 ? (
                      <span className="charts__badge charts__badge--error">
                        {chart.errorCount} Fehler
                      </span>
                    ) : null}
                    {chart.warningCount > 0 ? (
                      <span className="charts__badge">{chart.warningCount} Warnungen</span>
                    ) : null}
                    {chart.manualCells > 0 ? (
                      <span className="charts__badge">{chart.manualCells} korrigiert</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>

            {detail ? (
              <ChartDetail
                chart={detail}
                onApprove={() => void approveOne(detail.id)}
                onChanged={async (updated, message) => {
                  setDetail(updated);
                  setNotice(message);
                  await loadList();
                }}
              />
            ) : (
              <p className="charts__empty">Ein Chart aus der Liste wählen.</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface DetailProps {
  chart: ReviewChartDetail;
  onApprove: () => void;
  onChanged: (updated: ReviewChartDetail, message: string) => Promise<void>;
}

function ChartDetail({ chart, onApprove, onChanged }: DetailProps): JSX.Element {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');

  const byHand = new Map(chart.cells.map((cell) => [cell.hand, cell]));

  const markUnusable = async (): Promise<void> => {
    if (reason.trim() === '') return;
    const updated = await apiClient.markChartUnusable(chart.id, reason);
    setReason('');
    await onChanged(updated, 'Chart als unbrauchbar vermerkt.');
  };

  return (
    <section className="charts__detail">
      <header className="charts__detail-header">
        <h2>
          {chart.captionNumber === null ? 'Chart' : `Hand Range ${chart.captionNumber}`}{' '}
          <span className={`charts__state charts__state--${chart.state}`}>
            {STATE_LABEL[chart.state] ?? chart.state}
          </span>
        </h2>
        <div className="charts__detail-actions">
          <button type="button" onClick={onApprove} disabled={chart.state === 'approved'}>
            Freigeben
          </button>
        </div>
      </header>

      {chart.captionRaw ? <p className="charts__caption">{chart.captionRaw}</p> : null}

      <FindingList findings={chart.findings} />

      <TotalsTable weighted={chart.weightedTotals} caption={chart.captionTotals} />

      <div className="charts__side-by-side">
        <figure className="charts__image">
          <img src={chart.imageUrl} alt={`Original-Chart ${chart.captionNumber ?? ''}`} />
          <figcaption>Original aus dem Buch</figcaption>
        </figure>

        <div className="charts__grid-wrapper">
          <table className="charts__grid" aria-label="Gelesene Matrix">
            <tbody>
              {CARD_RANKS.map((row, rowIndex) => (
                <tr key={row}>
                  {CARD_RANKS.map((_column, columnIndex) => {
                    const hand = CHART_HANDS[rowIndex * 13 + columnIndex] as string;
                    const cell = byHand.get(hand);
                    const aggression =
                      cell?.actions
                        .filter((action) => action.kind !== 'fold')
                        .reduce((sum, action) => sum + action.percent, 0) ?? 0;
                    const classes = [
                      'charts__cell',
                      cell?.flagged ? 'charts__cell--flagged' : '',
                      cell?.source === 'manual' ? 'charts__cell--manual' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <td key={hand}>
                        <button
                          type="button"
                          className={classes}
                          style={{ opacity: 0.25 + (aggression / 100) * 0.75 }}
                          onClick={() => setEditing(editing === hand ? undefined : hand)}
                          title={
                            cell === undefined
                              ? `${hand}: fehlt`
                              : `${hand}: ${cell.actions.map((action) => `${action.kind} ${action.percent}%`).join(', ')}`
                          }
                        >
                          {hand}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== undefined ? (
        <CellForm
          chartId={chart.id}
          hand={editing}
          cell={byHand.get(editing)}
          onSaved={async (updated) => {
            setEditing(undefined);
            await onChanged(updated, `Zelle ${editing} korrigiert.`);
          }}
        />
      ) : null}

      <section className="charts__unusable">
        <h3>Unbrauchbar</h3>
        <p className="charts__hint">
          Wenn das Chart auch nach Korrektur nicht verwertbar ist: mit Begründung verwerfen. Das ist
          der dokumentierte Rest.
        </p>
        {chart.unusableReason ? <p role="note">Bereits verworfen: {chart.unusableReason}</p> : null}
        <label>
          Begründung
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button type="button" onClick={() => void markUnusable()} disabled={reason.trim() === ''}>
          Als unbrauchbar markieren
        </button>
      </section>
    </section>
  );
}

function FindingList({ findings }: { findings: readonly ChartFinding[] }): JSX.Element {
  if (findings.length === 0) {
    return <p className="charts__findings charts__findings--clean">Keine Befunde.</p>;
  }
  return (
    <section className="charts__findings" aria-label="Befunde">
      <h3>Befunde ({findings.length})</h3>
      <ul>
        {findings.map((finding, index) => (
          <li key={`${finding.kind}-${index}`} className={`charts__finding--${finding.severity}`}>
            <span className="charts__finding-check">
              {CHECK_LABEL[finding.check] ?? finding.check}
            </span>{' '}
            {finding.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TotalsTable({
  weighted,
  caption,
}: {
  weighted: Readonly<Record<string, number>>;
  caption: Readonly<Record<string, number>>;
}): JSX.Element {
  const kinds = [...new Set([...Object.keys(caption), ...Object.keys(weighted)])];
  if (kinds.length === 0) return <></>;
  return (
    <table className="charts__totals-table" aria-label="Gesamtfrequenzen">
      <thead>
        <tr>
          <th>Aktion</th>
          <th>gelesen (combo-gewichtet)</th>
          <th>Bildunterschrift</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <tr key={kind}>
            <td>{kind}</td>
            <td>{weighted[kind] === undefined ? '—' : `${weighted[kind].toFixed(1)} %`}</td>
            <td>{caption[kind] === undefined ? '—' : `${caption[kind].toFixed(1)} %`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface CellFormProps {
  chartId: string;
  hand: string;
  cell: ReviewChartDetail['cells'][number] | undefined;
  onSaved: (updated: ReviewChartDetail) => Promise<void>;
}

function CellForm({ chartId, hand, cell, onSaved }: CellFormProps): JSX.Element {
  const [text, setText] = useState(
    (cell?.actions ?? []).map((action) => `${action.kind} ${action.percent}`).join('\n'),
  );
  const [error, setError] = useState<string | undefined>(undefined);

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const actions = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          kind: parts[0] ?? '',
          ...(parts.length > 2 ? { sizing: parts[1] as string } : {}),
          percent: Number(parts[parts.length - 1]),
        };
      });

    try {
      const updated = await apiClient.correctChartCells(chartId, { cells: [{ hand, actions }] });
      setError(undefined);
      await onSaved(updated);
    } catch (caught) {
      const fields = (caught as { fields?: readonly { message: string }[] }).fields ?? [];
      setError(
        fields.length > 0
          ? fields.map((field) => field.message).join(' ')
          : caught instanceof Error
            ? caught.message
            : 'Korrektur fehlgeschlagen.',
      );
    }
  };

  return (
    <form className="charts__cell-form" onSubmit={(event) => void save(event)}>
      <h3>Zelle {hand} korrigieren</h3>
      <label>
        Aktionen — eine je Zeile, Form <code>art [sizing] prozent</code>
        <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit">Korrektur speichern</button>
    </form>
  );
}
