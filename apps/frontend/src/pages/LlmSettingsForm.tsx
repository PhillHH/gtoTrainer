import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  LlmPingResponse,
  LlmSettings,
  LlmSettingsResponse,
  SettingsFieldError,
} from '@gto/shared';
import { ApiError, apiClient } from '../api/client.js';
import type { ApiFieldError } from '../api/client.js';

/**
 * Provider- und Modellwahl samt Ping-Test (AP2.T2.6).
 *
 * Die Werte kommen beim Oeffnen vom Server - inklusive Auswahl und Grenzen,
 * damit hier nichts hartkodiert ist. Fehlgeschlagene Validierung wird **am
 * Feld** angezeigt, nicht nur als pauschale Meldung.
 */

type FieldErrors = Partial<Record<keyof LlmSettings, string>>;

type SaveState = 'idle' | 'saving' | 'saved';

export function LlmSettingsForm(): JSX.Element {
  const [data, setData] = useState<LlmSettingsResponse | undefined>(undefined);
  const [form, setForm] = useState<LlmSettings | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<LlmPingResponse | undefined>(undefined);
  const [pingError, setPingError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let aktiv = true;
    apiClient
      .fetchLlmSettings()
      .then((response) => {
        if (!aktiv) return;
        setData(response);
        setForm(response.settings);
      })
      .catch((error: unknown) => {
        if (!aktiv) return;
        setLoadError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
      });
    return () => {
      aktiv = false;
    };
  }, []);

  const update = <K extends keyof LlmSettings>(field: K, value: LlmSettings[K]): void => {
    setForm((current) => (current === undefined ? current : { ...current, [field]: value }));
    setSaveState('idle');
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (form === undefined) return;

    setSaveState('saving');
    setFieldErrors({});
    setSaveError(undefined);

    try {
      const response = await apiClient.saveLlmSettings(form);
      setData(response);
      setForm(response.settings);
      setSaveState('saved');
    } catch (error) {
      setSaveState('idle');
      if (error instanceof ApiError && error.fields.length > 0) {
        setFieldErrors(toFieldErrors(error.fields));
        setSaveError('Bitte die markierten Felder korrigieren.');
        return;
      }
      setSaveError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
    }
  };

  const runPing = async (): Promise<void> => {
    setPinging(true);
    setPingResult(undefined);
    setPingError(undefined);
    try {
      setPingResult(await apiClient.pingLlm());
    } catch (error) {
      setPingError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
    } finally {
      setPinging(false);
    }
  };

  if (loadError !== undefined) {
    return (
      <div className="card">
        <h2>Provider und Modell</h2>
        <p role="alert" className="calls__error">
          {loadError}
        </p>
      </div>
    );
  }

  if (data === undefined || form === undefined) {
    return (
      <div className="card">
        <h2>Provider und Modell</h2>
        <p className="muted">Wird geladen …</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Provider und Modell</h2>
      <p className="muted">
        Gilt ab dem nächsten Aufruf — ein Neustart ist nicht nötig.{' '}
        {data.apiKeyConfigured
          ? 'Ein Anthropic-API-Schlüssel ist hinterlegt.'
          : 'Es ist kein Anthropic-API-Schlüssel hinterlegt; der Provider „api" schlägt ohne ihn fehl.'}
      </p>

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="settings__field">
          <label htmlFor="llm-provider">Provider</label>
          <select
            id="llm-provider"
            value={form.provider}
            aria-invalid={fieldErrors.provider !== undefined}
            aria-describedby={fieldErrors.provider === undefined ? undefined : 'llm-provider-error'}
            onChange={(event) => update('provider', event.target.value as LlmSettings['provider'])}
          >
            <option value="cli">CLI (Claude-Subscription)</option>
            <option value="api">API (Anthropic Messages API)</option>
          </select>
          <FieldError id="llm-provider-error" message={fieldErrors.provider} />
        </div>

        <div className="settings__field">
          <label htmlFor="llm-model">Modell</label>
          <select
            id="llm-model"
            value={form.model}
            aria-invalid={fieldErrors.model !== undefined}
            aria-describedby={fieldErrors.model === undefined ? undefined : 'llm-model-error'}
            onChange={(event) => update('model', event.target.value as LlmSettings['model'])}
          >
            {data.modelChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <FieldError id="llm-model-error" message={fieldErrors.model} />
        </div>

        <NumberField
          id="llm-timeout"
          label="Timeout je Aufruf (ms)"
          value={form.timeoutMs}
          range={data.ranges.timeoutMs}
          error={fieldErrors.timeoutMs}
          onChange={(value) => update('timeoutMs', value)}
        />
        <NumberField
          id="llm-concurrency"
          label="Gleichzeitige Aufrufe"
          value={form.maxConcurrency}
          range={data.ranges.maxConcurrency}
          error={fieldErrors.maxConcurrency}
          onChange={(value) => update('maxConcurrency', value)}
        />
        <NumberField
          id="llm-attempts"
          label="Versuche je Aufruf"
          value={form.maxAttempts}
          range={data.ranges.maxAttempts}
          error={fieldErrors.maxAttempts}
          onChange={(value) => update('maxAttempts', value)}
        />

        {saveError !== undefined && (
          <p role="alert" className="calls__error">
            {saveError}
          </p>
        )}

        <div className="settings__actions">
          <button type="submit" disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Wird gespeichert …' : 'Speichern'}
          </button>
          {saveState === 'saved' && (
            <span role="status" className="settings__saved">
              Gespeichert.
            </span>
          )}
        </div>
      </form>

      <hr />

      <h3>Testaufruf</h3>
      <p className="muted">
        Setzt einen echten, minimalen Aufruf gegen die aktuelle Einstellung ab.{' '}
        <strong>Das verbraucht echtes Kontingent bzw. Guthaben.</strong>
      </p>
      <button type="button" onClick={() => void runPing()} disabled={pinging}>
        {pinging ? 'Testaufruf läuft …' : 'Testaufruf ausführen'}
      </button>

      {pingError !== undefined && (
        <p role="alert" className="calls__error">
          {pingError}
        </p>
      )}

      {pingResult !== undefined && pingResult.ok && (
        <div className="settings__ping settings__ping--ok" data-testid="ping-result">
          <p>
            <strong>Erfolgreich.</strong> {pingResult.provider} · {pingResult.model} ·{' '}
            {pingResult.durationMs} ms
          </p>
          <pre className="calls__text">{pingResult.text}</pre>
        </div>
      )}

      {pingResult !== undefined && !pingResult.ok && (
        <div className="settings__ping settings__ping--error" data-testid="ping-result">
          <p role="alert">
            <strong>Fehlgeschlagen ({pingResult.kind}).</strong> {pingResult.message}
          </p>
          <p className="muted">{pingResult.hint}</p>
        </div>
      )}
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }): JSX.Element | null {
  if (message === undefined) return null;
  return (
    <p id={id} role="alert" className="settings__field-error">
      {message}
    </p>
  );
}

interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly range: { readonly min: number; readonly max: number };
  readonly error?: string;
  readonly onChange: (value: number) => void;
}

function NumberField({ id, label, value, range, error, onChange }: NumberFieldProps): JSX.Element {
  return (
    <div className="settings__field">
      <label htmlFor={id}>
        {label}{' '}
        <span className="muted">
          ({range.min}–{range.max})
        </span>
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={range.min}
        max={range.max}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * Ordnet feldweise Ablehnungen den Formularfeldern zu.
 *
 * `ApiError.fields` traegt seit AP3.T3.2 die Feldnamen mehrerer Vertraege und
 * ist deshalb `string`-breit. Hier wird auf die Felder dieses Formulars
 * verengt; alles andere gehoert nicht hierher und wird uebersprungen.
 */
function toFieldErrors(fields: readonly ApiFieldError[]): FieldErrors {
  const known = new Set<string>(SETTINGS_FIELDS);
  const result: FieldErrors = {};
  for (const entry of fields) {
    if (known.has(entry.field)) result[entry.field as SettingsFieldError['field']] = entry.message;
  }
  return result;
}

/** Felder, die dieses Formular kennt. */
const SETTINGS_FIELDS = [
  'provider',
  'model',
  'timeoutMs',
  'maxConcurrency',
  'maxAttempts',
] as const satisfies readonly SettingsFieldError['field'][];
