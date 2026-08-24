import { useCallback, useEffect, useState } from 'react';
import { conceptTopicAreaLabel } from '@gto/shared';
import type {
  ConceptDetail,
  ConceptIssue,
  ConceptLevel,
  ConceptListResponse,
  ConceptTopicArea,
} from '@gto/shared';
import { apiClient } from '../api/client.js';
import './ConceptsPage.css';

/**
 * Review-Ansicht des Konzept-Graphen (AP3.T3.2, Subtask 7).
 *
 * Bewusst schlicht: Liste je Kapitel, ein aufklappbares Bearbeitungsformular,
 * Bestaetigen einzeln und je Kapitel. Kein Design-Projekt - der Zweck ist,
 * dass ein Mensch die KI-Vorschlaege durchgehen und korrigieren kann, bevor
 * AP4 darauf Mastery und Skill-Ratings aufbaut.
 */

const ISSUE_LABEL: Readonly<Record<ConceptIssue['kind'], string>> = {
  'unresolved-prerequisite': 'Offene Voraussetzung',
  cycle: 'Zyklus',
  duplicate: 'Dublette',
  'without-section': 'Ohne Sektion',
  'chapter-empty': 'Kapitel ohne Konzepte',
};

const LEVEL_LABEL: Readonly<Record<ConceptLevel, string>> = {
  einsteiger: 'Einsteiger',
  fortgeschritten: 'Fortgeschritten',
  experte: 'Experte',
};

export function ConceptsPage(): JSX.Element {
  const [data, setData] = useState<ConceptListResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setData(await apiClient.fetchConcepts());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approveOne = async (id: string): Promise<void> => {
    try {
      await apiClient.approveConcept(id);
      setNotice('Konzept bestätigt.');
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Bestätigen fehlgeschlagen.');
    }
  };

  const approveAll = async (chapterNumber: number): Promise<void> => {
    try {
      const result = await apiClient.approveChapter(chapterNumber);
      setNotice(`${result.approved} Konzepte in Kapitel ${chapterNumber} bestätigt.`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Bestätigen fehlgeschlagen.');
    }
  };

  return (
    <section className="concepts">
      <header className="concepts__header">
        <div>
          <h1>Konzepte</h1>
          <p className="concepts__hint">
            KI-Vorschläge aus den Buchsektionen. Prüfen, korrigieren, bestätigen — erst danach baut
            der Lernpfad darauf auf.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Neu laden
        </button>
      </header>

      {notice ? <p role="status">{notice}</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {loading && !data ? <p>Konzepte werden geladen …</p> : null}

      {data ? (
        <>
          <p className="concepts__totals">
            {data.totals.concepts} Konzepte — {data.totals.draft} offen, {data.totals.approved}{' '}
            bestätigt, {data.totals.withoutSection} ohne Sektionszuordnung.
          </p>

          <IssueList issues={data.issues} />

          {data.chapters.map((group) => (
            <section key={group.chapterNumber} className="concepts__chapter">
              <header className="concepts__chapter-header">
                <h2>
                  Kapitel {group.chapterNumber} — {group.chapterTitle}
                </h2>
                <button
                  type="button"
                  onClick={() => void approveAll(group.chapterNumber)}
                  disabled={group.concepts.every((entry) => entry.state === 'approved')}
                >
                  Kapitel bestätigen
                </button>
              </header>

              {group.concepts.length === 0 ? (
                <p className="concepts__empty">Kein Konzept in diesem Kapitel.</p>
              ) : (
                <ul className="concepts__list">
                  {group.concepts.map((entry) => (
                    <li key={entry.id} className="concepts__item">
                      <ConceptRow
                        concept={entry}
                        expanded={editing === entry.id}
                        onToggle={() => setEditing(editing === entry.id ? undefined : entry.id)}
                        onApprove={() => void approveOne(entry.id)}
                      />
                      {editing === entry.id ? (
                        <ConceptForm
                          concept={entry}
                          topicAreas={data.topicAreas}
                          levels={data.levels}
                          allConcepts={data.chapters.flatMap((chapter) => chapter.concepts)}
                          onSaved={async (message) => {
                            setNotice(message);
                            setEditing(undefined);
                            await load();
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      ) : null}
    </section>
  );
}

/** Auffaelligkeiten - bewusst oben, nicht versteckt. */
function IssueList({ issues }: { issues: readonly ConceptIssue[] }): JSX.Element {
  if (issues.length === 0) {
    return <p className="concepts__issues concepts__issues--clean">Keine Auffälligkeiten.</p>;
  }
  return (
    <section className="concepts__issues" aria-label="Auffälligkeiten">
      <h2>Auffälligkeiten ({issues.length})</h2>
      <ul>
        {issues.map((issue, index) => (
          <li key={`${issue.kind}-${index}`}>
            <span className="concepts__issue-kind">{ISSUE_LABEL[issue.kind]}</span> {issue.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  concept: ConceptDetail;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
}

function ConceptRow({ concept, expanded, onToggle, onApprove }: RowProps): JSX.Element {
  return (
    <div className="concepts__row">
      <div className="concepts__row-main">
        <h3>{concept.title}</h3>
        <p className="concepts__summary">{concept.summary}</p>
        <p className="concepts__meta">
          <span className={`concepts__state concepts__state--${concept.state}`}>
            {concept.state === 'approved' ? 'bestätigt' : 'offen'}
          </span>
          <span>{conceptTopicAreaLabel(concept.topicArea)}</span>
          <span>ab {LEVEL_LABEL[concept.minLevel]}</span>
          <span>
            {concept.sectionCount} Sektionen · {concept.chartCount} Charts
          </span>
        </p>
        <p className="concepts__prereqs">
          Voraussetzungen:{' '}
          {concept.prerequisites.length === 0 && concept.unresolvedPrerequisites.length === 0
            ? 'keine'
            : [
                ...concept.prerequisites.map((entry) => entry.title),
                ...concept.unresolvedPrerequisites.map((title) => `${title} (unbekannt)`),
              ].join(', ')}
        </p>
      </div>
      <div className="concepts__row-actions">
        <button type="button" onClick={onToggle}>
          {expanded ? 'Schließen' : 'Bearbeiten'}
        </button>
        <button type="button" onClick={onApprove} disabled={concept.state === 'approved'}>
          Bestätigen
        </button>
      </div>
    </div>
  );
}

interface FormProps {
  concept: ConceptDetail;
  topicAreas: readonly { id: ConceptTopicArea; label: string }[];
  levels: readonly ConceptLevel[];
  allConcepts: readonly ConceptDetail[];
  onSaved: (message: string) => Promise<void>;
}

function ConceptForm({
  concept,
  topicAreas,
  levels,
  allConcepts,
  onSaved,
}: FormProps): JSX.Element {
  const [title, setTitle] = useState(concept.title);
  const [summary, setSummary] = useState(concept.summary);
  const [topicArea, setTopicArea] = useState<ConceptTopicArea>(concept.topicArea);
  const [minLevel, setMinLevel] = useState<ConceptLevel>(concept.minLevel);
  const [prerequisiteIds, setPrerequisiteIds] = useState<string[]>(
    concept.prerequisites.map((entry) => entry.id),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      await apiClient.updateConcept(concept.id, {
        title,
        summary,
        topicArea,
        minLevel,
        prerequisiteIds,
      });
      setError(undefined);
      await onSaved('Änderung gespeichert.');
    } catch (caught) {
      // Feldweise Ablehnungen kommen als `fields` zurueck (siehe API-Client).
      const fields = (caught as { fields?: readonly { message: string }[] }).fields ?? [];
      setError(
        fields.length > 0
          ? fields.map((field) => field.message).join(' ')
          : caught instanceof Error
            ? caught.message
            : 'Speichern fehlgeschlagen.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="concepts__form" onSubmit={(event) => void submit(event)}>
      <label>
        Titel
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>

      <label>
        Kurzdefinition
        <textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>

      <label>
        Themenbereich
        <select
          value={topicArea}
          onChange={(event) => setTopicArea(event.target.value as ConceptTopicArea)}
        >
          {topicAreas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Ab Level
        <select
          value={minLevel}
          onChange={(event) => setMinLevel(event.target.value as ConceptLevel)}
        >
          {levels.map((level) => (
            <option key={level} value={level}>
              {LEVEL_LABEL[level]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Voraussetzungen
        <select
          multiple
          size={6}
          value={prerequisiteIds}
          onChange={(event) =>
            setPrerequisiteIds([...event.target.selectedOptions].map((option) => option.value))
          }
        >
          {allConcepts
            .filter((entry) => entry.id !== concept.id)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
        </select>
      </label>

      {error ? <p role="alert">{error}</p> : null}

      <button type="submit" disabled={saving}>
        Speichern
      </button>
    </form>
  );
}
