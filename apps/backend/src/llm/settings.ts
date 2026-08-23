import { inArray } from 'drizzle-orm';
import { LLM_MODEL_IDS, LLM_SETTINGS_RANGES, isLlmModelId, isLlmProviderId } from '@gto/shared';
import type {
  LlmSettings,
  LlmSettingsUpdate,
  SettingsFieldError,
  SettingsOrigin,
} from '@gto/shared';
import type { LlmConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { config as configTable } from '../db/schema.js';

/**
 * Laufzeit-Einstellungen des LLM-Gateways (AP2.T2.6).
 *
 * Gespeichert wird in der `config`-Tabelle aus AP1 - dieselbe Quelle, aus der
 * die Provider-Registry seit T2.3 den aktiven Provider liest. Dieser Task
 * liefert den Schreibweg und die serverseitige Pruefung.
 *
 * Nicht gesetzte Werte fallen auf die Umgebungskonfiguration zurueck. Die
 * Oberflaeche bekommt beides: den geltenden Wert **und** die Herkunft, damit
 * sie nichts raten muss.
 */

/** Schluessel in der `config`-Tabelle, je Einstellung einer. */
export const SETTINGS_KEYS = {
  provider: 'llm.provider',
  model: 'llm.model',
  timeoutMs: 'llm.timeout_ms',
  maxConcurrency: 'llm.max_concurrency',
  maxAttempts: 'llm.max_attempts',
} as const satisfies Readonly<Record<keyof LlmSettings, string>>;

const FIELDS = Object.keys(SETTINGS_KEYS) as (keyof LlmSettings)[];

export interface ResolvedSettings {
  readonly settings: LlmSettings;
  readonly origin: Readonly<Record<keyof LlmSettings, SettingsOrigin>>;
}

/** Fehler, wenn mindestens ein Feld die Pruefung nicht besteht. */
export class SettingsValidationError extends Error {
  readonly fields: readonly SettingsFieldError[];

  constructor(fields: readonly SettingsFieldError[]) {
    super(`Die Einstellungen wurden abgelehnt: ${fields.map((entry) => entry.field).join(', ')}.`);
    this.name = 'SettingsValidationError';
    this.fields = fields;
  }
}

/** Liest jemand die geltenden Einstellungen? Genau diese Form. */
export interface LlmSettingsReader {
  read(): Promise<LlmSettings>;
}

/**
 * Liest die geltenden Einstellungen: Tabelle vor Umgebung.
 *
 * Ein **ungueltiger** Wert in der Tabelle wird nicht still verworfen, sondern
 * durch den Default ersetzt und als `default` ausgewiesen - sonst haette man
 * eine Einstellung, die die Oberflaeche anzeigt, aber niemand benutzt.
 */
export async function resolveSettings(
  db: Database,
  fallback: LlmConfig,
): Promise<ResolvedSettings> {
  const rows = await db
    .select({ key: configTable.key, value: configTable.value })
    .from(configTable)
    .where(inArray(configTable.key, Object.values(SETTINGS_KEYS)));

  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const defaults = defaultsFrom(fallback);

  const settings: Record<string, unknown> = {};
  const origin: Record<string, SettingsOrigin> = {};

  for (const field of FIELDS) {
    const raw = stored.get(SETTINGS_KEYS[field]);
    const valid = raw === undefined || raw === null ? undefined : coerce(field, raw);
    settings[field] = valid ?? defaults[field];
    origin[field] = valid === undefined ? 'default' : 'config';
  }

  return {
    settings: settings as unknown as LlmSettings,
    origin: origin as Readonly<Record<keyof LlmSettings, SettingsOrigin>>,
  };
}

/** Die geltenden Einstellungen als schlanker Leser - fuer Worker und Ping. */
export function createSettingsReader(db: Database, fallback: LlmConfig): LlmSettingsReader {
  return {
    async read(): Promise<LlmSettings> {
      return (await resolveSettings(db, fallback)).settings;
    },
  };
}

/**
 * Prueft und speichert. Ungueltige Felder fuehren zu
 * `SettingsValidationError` - es wird **nichts** geschrieben und **nie** still
 * auf einen Default zurueckgefallen.
 */
export async function writeSettings(
  db: Database,
  patch: LlmSettingsUpdate,
  fallback: LlmConfig,
): Promise<ResolvedSettings> {
  const errors = validate(patch);
  if (errors.length > 0) throw new SettingsValidationError(errors);

  const entries = FIELDS.filter((field) => patch[field] !== undefined).map((field) => ({
    key: SETTINGS_KEYS[field],
    value: patch[field] as unknown,
  }));

  for (const entry of entries) {
    await db
      .insert(configTable)
      .values({ key: entry.key, value: entry.value as never })
      .onConflictDoUpdate({
        target: configTable.key,
        set: { value: entry.value as never, updatedAt: new Date() },
      });
  }

  return resolveSettings(db, fallback);
}

/**
 * Prueft jedes uebergebene Feld einzeln.
 *
 * Bewusst feldweise: Die Oberflaeche soll den Fehler **am** Feld anzeigen
 * koennen, nicht als pauschale Meldung.
 */
export function validate(patch: LlmSettingsUpdate): readonly SettingsFieldError[] {
  const errors: SettingsFieldError[] = [];

  const unknownFields = Object.keys(patch).filter(
    (key) => !(FIELDS as readonly string[]).includes(key),
  );
  for (const key of unknownFields) {
    errors.push({
      field: key as keyof LlmSettings,
      message: `Unbekanntes Feld "${key}". Erlaubt sind: ${FIELDS.join(', ')}.`,
    });
  }

  if (patch.provider !== undefined && !isLlmProviderId(patch.provider)) {
    errors.push({
      field: 'provider',
      message: `Unbekannter Provider "${String(patch.provider)}". Erlaubt sind "cli" und "api".`,
    });
  }

  if (patch.model !== undefined && !isLlmModelId(patch.model)) {
    errors.push({
      field: 'model',
      message: `Unbekanntes Modell "${String(patch.model)}". Erlaubt sind: ${LLM_MODEL_IDS.join(', ')}.`,
    });
  }

  checkRange(errors, patch, 'timeoutMs', 'Timeout je Aufruf');
  checkRange(errors, patch, 'maxConcurrency', 'Nebenlaeufigkeitslimit');
  checkRange(errors, patch, 'maxAttempts', 'Anzahl der Versuche');

  return errors;
}

function checkRange(
  errors: SettingsFieldError[],
  patch: LlmSettingsUpdate,
  field: 'timeoutMs' | 'maxConcurrency' | 'maxAttempts',
  label: string,
): void {
  const value = patch[field];
  if (value === undefined) return;

  const range = LLM_SETTINGS_RANGES[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ field, message: `${label} muss eine ganze Zahl sein.` });
    return;
  }
  if (value < range.min || value > range.max) {
    errors.push({
      field,
      message: `${label} muss zwischen ${range.min} und ${range.max} liegen, ist: ${value}.`,
    });
  }
}

/** Defaults kommen aus der Umgebungskonfiguration - kein zweiter Satz Zahlen. */
function defaultsFrom(fallback: LlmConfig): LlmSettings {
  return {
    provider: fallback.provider ?? 'cli',
    model: isLlmModelId(fallback.model) ? fallback.model : 'claude-sonnet-5',
    timeoutMs: clamp(fallback.timeoutMs, LLM_SETTINGS_RANGES.timeoutMs),
    maxConcurrency: clamp(fallback.maxConcurrency, LLM_SETTINGS_RANGES.maxConcurrency),
    maxAttempts: clamp(fallback.maxAttempts, LLM_SETTINGS_RANGES.maxAttempts),
  };
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(value, range.min), range.max);
}

/** Wandelt einen Tabellenwert in einen gueltigen Wert um, oder `undefined`. */
function coerce(field: keyof LlmSettings, raw: unknown): unknown {
  if (field === 'provider') return isLlmProviderId(raw) ? raw : undefined;
  if (field === 'model') return isLlmModelId(raw) ? raw : undefined;

  const range = LLM_SETTINGS_RANGES[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return raw >= range.min && raw <= range.max ? raw : undefined;
}
