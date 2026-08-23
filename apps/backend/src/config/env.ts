import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Zentrales, typisiertes Laden der Konfiguration.
 *
 * Bewusst ohne Zusatz-Dependency: `.env` wird ueber das in Node 20 eingebaute
 * `process.loadEnvFile()` gelesen, die Validierung ist handgeschrieben. Fehlt
 * eine Pflichtvariable, bricht der Start mit einer verstaendlichen Meldung ab,
 * statt spaeter an unerwarteter Stelle `undefined` zu produzieren.
 */

/** Fehler bei fehlender oder unbrauchbarer Konfiguration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Sucht die Repo-Wurzel, indem vom Startverzeichnis aus nach oben gelaufen
 * wird, bis `pnpm-workspace.yaml` gefunden ist.
 *
 * Bewusst nicht ueber `import.meta.dirname`: drizzle-kit laedt
 * `drizzle.config.ts` in einem Kontext, in dem das undefined ist.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new ConfigError(
        `Repo-Wurzel nicht gefunden (keine pnpm-workspace.yaml oberhalb von ${startDir}).`,
      );
    }
    current = parent;
  }
}

let envFileLoaded = false;

/**
 * Laedt die `.env` aus der Repo-Wurzel, sofern vorhanden. Bereits gesetzte
 * Prozess-Variablen haben Vorrang und werden nicht ueberschrieben.
 */
export function loadEnvFile(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;

  const envPath = resolve(findRepoRoot(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function requireEnv(key: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      `Pflicht-Umgebungsvariable ${key} fehlt oder ist leer. ` +
        `Lege eine .env nach dem Muster von .env.example an (cp .env.example .env).`,
    );
  }
  return raw.trim();
}

function optionalEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

function numberEnv(key: string, fallback: number): number {
  const raw = optionalEnv(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Umgebungsvariable ${key} muss eine positive Ganzzahl sein, ist: "${raw}".`,
    );
  }
  return parsed;
}

function assertPostgresUrl(key: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Umgebungsvariable ${key} ist keine gueltige URL.`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigError(
      `Umgebungsvariable ${key} muss mit postgres:// oder postgresql:// beginnen, hat aber "${parsed.protocol}".`,
    );
  }
  if (value.includes('__SET_A_STRONG_PASSWORD__')) {
    throw new ConfigError(
      `Umgebungsvariable ${key} enthaelt noch den Platzhalter aus .env.example. ` +
        `Bitte ein echtes Passwort eintragen.`,
    );
  }
  return value;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
}

/**
 * Liest und validiert die Konfiguration. Wirft `ConfigError`, wenn etwas fehlt.
 * Wird bei jedem Aufruf neu ausgewertet, damit Tests die Umgebung veraendern
 * koennen, ohne an einem Modul-Cache vorbeiarbeiten zu muessen.
 */
export function loadConfig(): AppConfig {
  loadEnvFile();

  const nodeEnv = optionalEnv('NODE_ENV') ?? 'development';

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: numberEnv('PORT', 3001),
    host: optionalEnv('HOST') ?? '0.0.0.0',
    databaseUrl: assertPostgresUrl('DATABASE_URL', requireEnv('DATABASE_URL')),
  };
}

/**
 * Verbindungs-URL fuer die Integrationstests. Faellt nicht stillschweigend auf
 * die Entwicklungsdatenbank zurueck - sonst wuerden Tests echte Daten loeschen.
 */
export function loadTestDatabaseUrl(): string {
  loadEnvFile();
  return assertPostgresUrl('TEST_DATABASE_URL', requireEnv('TEST_DATABASE_URL'));
}
