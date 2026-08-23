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
 * Gibt `undefined` zurueck, wenn keine gefunden wird - genau das ist der Fall
 * im Container, wo nur das gebuendelte Paket liegt und die Konfiguration ueber
 * echte Umgebungsvariablen kommt.
 *
 * Bewusst nicht ueber `import.meta.dirname`: drizzle-kit laedt
 * `drizzle.config.ts` in einem Kontext, in dem das undefined ist.
 */
export function tryFindRepoRoot(startDir: string = process.cwd()): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Wie {@link tryFindRepoRoot}, wirft aber, wenn keine Wurzel gefunden wird. */
export function findRepoRoot(startDir: string = process.cwd()): string {
  const root = tryFindRepoRoot(startDir);
  if (root === undefined) {
    throw new ConfigError(
      `Repo-Wurzel nicht gefunden (keine pnpm-workspace.yaml oberhalb von ${startDir}).`,
    );
  }
  return root;
}

let envFileLoaded = false;

/**
 * Laedt die `.env` aus der Repo-Wurzel, sofern vorhanden. Bereits gesetzte
 * Prozess-Variablen haben Vorrang und werden nicht ueberschrieben.
 */
export function loadEnvFile(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;

  // Im Container gibt es keine Repo-Wurzel und keine .env - die Konfiguration
  // kommt dort direkt aus den Umgebungsvariablen von Compose.
  const root = tryFindRepoRoot();
  if (root === undefined) return;

  const envPath = resolve(root, '.env');
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

function booleanEnv(key: string, fallback: boolean): boolean {
  const raw = optionalEnv(key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new ConfigError(`Umgebungsvariable ${key} muss true oder false sein, ist: "${raw}".`);
}

/** Liest eine kommaseparierte Liste; leer, wenn die Variable fehlt. */
function listEnv(key: string): readonly string[] {
  const raw = optionalEnv(key);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

/** Konfiguration rund um Authentifizierung und Session. */
export interface AuthConfig {
  /** Lebensdauer einer Session in Millisekunden. */
  readonly sessionTtlMs: number;
  /**
   * `Secure`-Flag der Cookies. Hinter dem Host-Nginx (ab T1.5) laeuft TLS,
   * dort muss es an sein. Lokal ohne HTTPS wuerde der Browser das Cookie sonst
   * verwerfen - deshalb konfigurierbar statt fest verdrahtet.
   */
  readonly cookieSecure: boolean;
  /** `SameSite`-Attribut der Cookies. */
  readonly cookieSameSite: 'lax' | 'strict';
  /** Erlaubte Herkuenfte fuer zustandsaendernde Requests (leer = keine Pruefung). */
  readonly allowedOrigins: readonly string[];
  /** Erlaubte Login-Fehlversuche je Zeitfenster. */
  readonly loginMaxAttempts: number;
  /** Laenge des Rate-Limit-Zeitfensters in Millisekunden. */
  readonly loginWindowMs: number;
  /**
   * Schalter fuer den TOTP-Hook. Default **false** - in T1.3 ist nur die
   * Einhaengestelle vorbereitet, keine vollstaendige TOTP-Pruefung.
   */
  readonly totpEnabled: boolean;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly auth: AuthConfig;
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
    auth: loadAuthConfig(nodeEnv),
  };
}

/** Liest die Auth-Konfiguration. Defaults sind fuer die Entwicklung sicher. */
function loadAuthConfig(nodeEnv: string): AuthConfig {
  const sameSiteRaw = (optionalEnv('COOKIE_SAMESITE') ?? 'lax').toLowerCase();
  if (sameSiteRaw !== 'lax' && sameSiteRaw !== 'strict') {
    throw new ConfigError(`COOKIE_SAMESITE muss "lax" oder "strict" sein, ist: "${sameSiteRaw}".`);
  }

  return {
    sessionTtlMs: numberEnv('SESSION_TTL_HOURS', 24 * 7) * 60 * 60 * 1000,
    // Default folgt der Umgebung: produktiv an, lokal aus.
    cookieSecure: booleanEnv('COOKIE_SECURE', nodeEnv === 'production'),
    cookieSameSite: sameSiteRaw,
    allowedOrigins: listEnv('ALLOWED_ORIGINS'),
    loginMaxAttempts: numberEnv('LOGIN_RATE_LIMIT_MAX_ATTEMPTS', 5),
    loginWindowMs: numberEnv('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
    totpEnabled: booleanEnv('TOTP_ENABLED', false),
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
