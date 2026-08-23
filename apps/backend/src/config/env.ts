import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isLlmProviderId } from '@gto/shared';
import type { LlmProviderId } from '@gto/shared';
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

/* -------------------------------------------------------------------------
 * LLM-Gateway (AP2.T2.2)
 * ---------------------------------------------------------------------- */

/**
 * Wie das Backend die Claude CLI erreicht.
 *
 * - `direct` - dieser Prozess startet die CLI selbst. Gilt lokal und fuer den
 *   Host-Runner.
 * - `socket` - dieser Prozess spricht den Host-Runner ueber einen
 *   Unix-Domain-Socket an. Gilt im Container (ADR-0022).
 *
 * Der Unterschied liegt **nur** in der Konfiguration; der Adaptercode ist
 * derselbe.
 */
export const LLM_TRANSPORTS = ['direct', 'socket'] as const;
export type LlmTransport = (typeof LLM_TRANSPORTS)[number];

/** Konfiguration des CLI-Adapters. */
export interface LlmConfig {
  readonly transport: LlmTransport;
  /**
   * Config-Verzeichnis der Claude CLI - **Profil B**. Pflicht, sobald dieser
   * Prozess die CLI selbst startet. Es gibt **keinen** Rueckfall auf ein
   * Default-Profil.
   */
  readonly claudeConfigDir: string | undefined;
  /** Ausfuehrbare Datei der CLI. */
  readonly cliPath: string;
  /**
   * Arbeitsverzeichnis des CLI-Prozesses. Bewusst ein leeres, projektfremdes
   * Verzeichnis: `-p` laedt sonst CLAUDE.md, Hooks und MCP-Server aus dem cwd.
   */
  readonly cliCwd: string;
  /** Pfad des Runner-Sockets. Pflicht bei `transport: 'socket'`. */
  readonly runnerSocketPath: string | undefined;
  /** Standardmodell, wenn der Request keines vorgibt. */
  readonly model: string;
  /** Standard-Timeout je Aufruf in Millisekunden. */
  readonly timeoutMs: number;
  /** Obergrenze gleichzeitiger CLI-Prozesse. */
  readonly maxConcurrency: number;
  /** Gesamtzahl der Versuche je Aufruf (1 = kein Retry). */
  readonly maxAttempts: number;
  /** Basiswartezeit des exponentiellen Backoffs in Millisekunden. */
  readonly retryBaseDelayMs: number;
  /** Obergrenze einer einzelnen Backoff-Wartezeit. */
  readonly retryMaxDelayMs: number;
  /** Harte Obergrenze fuer alle Versuche zusammen. */
  readonly retryTotalBudgetMs: number;

  /* --- Adapter B: Anthropic Messages API (T2.3) -------------------------- */

  /**
   * Startwert fuer den aktiven Provider. Die Laufzeitwahl kommt aus der
   * `config`-Tabelle (`llm.provider`); dieser Wert greift, solange dort nichts
   * hinterlegt ist. Im Typ optional, damit Tests eine Teilkonfiguration bauen
   * koennen - `loadLlmConfig()` setzt ihn immer.
   */
  readonly provider?: LlmProviderId;
  /**
   * Anthropic-API-Schluessel. **Nur** noetig, wenn der API-Adapter aktiv ist -
   * das Backend startet ohne Schluessel, solange die CLI der aktive Provider
   * ist. Wird nirgends geloggt oder in Fehlermeldungen ausgegeben.
   */
  readonly apiKey?: string;
  /** Abweichende Basis-URL, z. B. fuer einen Testserver. */
  readonly apiBaseUrl?: string;
}

/** Default-Socketname innerhalb von `LLM_RUNNER_SOCKET_DIR`. */
export const LLM_RUNNER_SOCKET_NAME = 'gto-llm.sock';

/**
 * Liest die LLM-Konfiguration. Wird bei der **Adapter-Initialisierung**
 * aufgerufen, nicht beim Serverstart: Das Backend muss auch ohne CLI starten
 * koennen (CI, und ab T2.3 der reine API-Adapter).
 *
 * Wirft `ConfigError`, wenn `CLAUDE_CONFIG_DIR` fehlt und dieser Prozess die
 * CLI selbst starten wuerde.
 */
export function loadLlmConfig(): LlmConfig {
  loadEnvFile();

  const transportRaw = optionalEnv('LLM_TRANSPORT') ?? 'direct';
  if (!(LLM_TRANSPORTS as readonly string[]).includes(transportRaw)) {
    throw new ConfigError(
      `LLM_TRANSPORT muss "direct" oder "socket" sein, ist: "${transportRaw}".`,
    );
  }
  const transport = transportRaw as LlmTransport;

  const claudeConfigDir =
    transport === 'direct' ? requireClaudeConfigDir() : optionalEnv('CLAUDE_CONFIG_DIR');

  const runnerSocketPath = transport === 'socket' ? requireRunnerSocketPath() : resolveSocketPath();

  const maxAttempts = numberEnv('LLM_MAX_ATTEMPTS', 3);
  const apiKey = readApiKey();
  const apiBaseUrl = optionalEnv('ANTHROPIC_BASE_URL');

  return {
    provider: readProviderId(),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    transport,
    claudeConfigDir,
    cliPath: optionalEnv('LLM_CLI_PATH') ?? 'claude',
    cliCwd: optionalEnv('LLM_CLI_CWD') ?? tmpdir(),
    runnerSocketPath,
    model: optionalEnv('LLM_MODEL') ?? 'claude-sonnet-5',
    timeoutMs: numberEnv('LLM_TIMEOUT_MS', 120_000),
    maxConcurrency: numberEnv('LLM_MAX_CONCURRENCY', 2),
    maxAttempts,
    retryBaseDelayMs: numberEnv('LLM_RETRY_BASE_DELAY_MS', 1_000),
    retryMaxDelayMs: numberEnv('LLM_RETRY_MAX_DELAY_MS', 30_000),
    retryTotalBudgetMs: numberEnv('LLM_RETRY_TOTAL_BUDGET_MS', 300_000),
  };
}

/**
 * Liest den Startwert des aktiven Providers. Ein unbekannter Wert ist ein
 * Konfigurationsfehler - kein stiller Rueckfall auf einen Default.
 */
function readProviderId(): LlmProviderId {
  const raw = optionalEnv('LLM_PROVIDER');
  if (raw === undefined) return 'cli';
  if (!isLlmProviderId(raw)) {
    throw new ConfigError(`LLM_PROVIDER muss "cli" oder "api" sein, ist: "${raw}".`);
  }
  return raw;
}

/**
 * Liest den API-Schluessel. Der Platzhalter aus `.env.example` gilt als
 * "nicht gesetzt", damit eine unveraenderte Vorlage nicht in einen
 * 401-Fehler laeuft, sondern in die verstaendliche Meldung des Adapters.
 */
function readApiKey(): string | undefined {
  const raw = optionalEnv('ANTHROPIC_API_KEY');
  if (raw === undefined || raw.startsWith('__SET_')) return undefined;
  return raw;
}

/**
 * Pflichtpruefung fuer das Profil-B-Verzeichnis. Die Meldung sagt, was zu tun
 * ist - ein stiller Default waere hier besonders gefaehrlich, weil er das
 * falsche Subscription-Profil verbrauchen wuerde.
 */
function requireClaudeConfigDir(): string {
  const value = optionalEnv('CLAUDE_CONFIG_DIR');
  if (value === undefined) {
    throw new ConfigError(
      'Pflicht-Umgebungsvariable CLAUDE_CONFIG_DIR fehlt oder ist leer. ' +
        'Der Claude-CLI-Adapter laeuft ausschliesslich gegen Profil B und faellt ' +
        'nicht auf ein Default-Profil zurueck. Setze CLAUDE_CONFIG_DIR auf das ' +
        'Profil-B-Verzeichnis (siehe .env.example) und stelle sicher, dass es ' +
        'eingeloggt ist.',
    );
  }
  return value;
}

function requireRunnerSocketPath(): string {
  const explicit = resolveSocketPath();
  if (explicit === undefined) {
    throw new ConfigError(
      'LLM_TRANSPORT=socket verlangt LLM_RUNNER_SOCKET_PATH oder ' +
        'LLM_RUNNER_SOCKET_DIR. Im Container wird das Socket-Verzeichnis des ' +
        'Host-Runners eingehaengt (siehe docker-compose.yml und ADR-0022).',
    );
  }
  return explicit;
}

function resolveSocketPath(): string | undefined {
  const explicit = optionalEnv('LLM_RUNNER_SOCKET_PATH');
  if (explicit !== undefined) return explicit;
  const dir = optionalEnv('LLM_RUNNER_SOCKET_DIR');
  if (dir === undefined) return undefined;
  return resolve(dir, LLM_RUNNER_SOCKET_NAME);
}

/* -------------------------------------------------------------------------
 * Job-Worker (AP2.T2.5)
 * ---------------------------------------------------------------------- */

/** Konfiguration des Job-Workers. */
export interface WorkerConfig {
  /**
   * Laeuft der Worker in diesem Prozess? Default **an**: Der Worker ist Teil
   * des Backend-Prozesses (ADR-0026). Zum Abschalten `WORKER_ENABLED=false` -
   * z. B. wenn man den Stack nur fuer HTTP hochfahren will.
   */
  readonly enabled: boolean;
  /** Wartezeit zwischen zwei Durchlaeufen, wenn nichts zu tun war. */
  readonly pollIntervalMs: number;
  /**
   * Ab wann ein Job im Zustand `running` als verwaist gilt und erneut geholt
   * werden darf. Muss deutlich ueber dem laengsten Aufruf liegen, sonst wird
   * ein langsamer Job doppelt verarbeitet.
   */
  readonly staleAfterMs: number;
  /** Obergrenze fuer Prompt und Antwort im Aufruf-Protokoll. */
  readonly logMaxChars: number;
}

/** Liest die Worker-Konfiguration. Alle Werte haben brauchbare Defaults. */
export function loadWorkerConfig(): WorkerConfig {
  loadEnvFile();
  return {
    enabled: booleanEnv('WORKER_ENABLED', true),
    pollIntervalMs: numberEnv('WORKER_POLL_INTERVAL_MS', 2_000),
    // Fuenf Minuten: klar ueber dem Standard-Timeout eines Aufrufs (2 min),
    // aber kurz genug, dass ein Absturz die Queue nicht lange blockiert.
    staleAfterMs: numberEnv('WORKER_STALE_AFTER_MS', 300_000),
    logMaxChars: numberEnv('LLM_LOG_MAX_CHARS', 20_000),
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
