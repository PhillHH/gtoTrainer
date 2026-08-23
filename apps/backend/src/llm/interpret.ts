import type { LlmCallMeta, LlmErrorKind, LlmRequest, LlmResponse } from '@gto/shared';
import { LlmError } from './errors.js';
import { extractJson, validateAgainstSchema } from './parse.js';
import type { CliResult } from './spawn.js';

/**
 * Wertet das Rohergebnis eines CLI-Laufs aus: Erfolg -> `LlmResponse`,
 * sonst `LlmError` mit einer Kategorie der Taxonomie aus T2.1.
 *
 * Grundlage sind die in T2.1 beobachteten Ausgaben (ADR-0021), insbesondere:
 * Der Erfolg haengt an `is_error` und dem Exit-Code, **nicht** an `subtype` -
 * im Auth-Fehlerfall stand dort `"success"` neben `is_error: true`.
 */

const PROVIDER = 'cli' as const;

/** Das `result`-Ereignis am Ende des stream-json-Stroms. */
interface CliResultEvent {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly usage?: unknown;
  readonly modelUsage?: unknown;
  readonly api_error_status?: unknown;
}

export function interpretCliResult(
  request: LlmRequest,
  cli: CliResult,
  defaults: { readonly model: string; readonly durationMs: number },
): LlmResponse {
  if (cli.timedOut) {
    throw fail(
      'timeout',
      `Die Claude CLI hat nicht innerhalb des Zeitlimits geantwortet und wurde beendet (${cli.durationMs} ms).`,
    );
  }

  if (cli.spawnError !== undefined) {
    throw fail('auth', spawnErrorMessage(cli.spawnError));
  }

  const event = findResultEvent(cli.stdout);

  if (event === undefined) {
    // Kein auswertbares Ergebnis: Bei Exit != 0 ist die Ursache ein Fehler der
    // CLI, sonst eine unerwartete Ausgabeform.
    if (cli.exitCode !== 0) throw classify(cli, cli.stderr || cli.stdout);
    throw fail(
      'parse',
      `Die Claude CLI lieferte kein result-Ereignis. stdout (gekuerzt): ${excerpt(cli.stdout)}`,
    );
  }

  if (event.is_error === true || cli.exitCode !== 0) {
    throw classify(cli, asText(event.result) ?? cli.stderr);
  }

  const text = asText(event.result) ?? '';
  const meta = buildMeta(event, request, defaults);

  if (request.jsonSchema === undefined) {
    return { text, json: null, meta };
  }

  const payload = event.structured_output ?? extractJson(text);
  if (payload === undefined) {
    throw fail(
      'parse',
      `Die Antwort enthaelt keine auswertbare JSON-Nutzlast, obwohl ein Schema verlangt war. Antwort (gekuerzt): ${excerpt(text)}`,
    );
  }

  const problems = validateAgainstSchema(payload, request.jsonSchema);
  if (problems.length > 0) {
    throw fail('parse', `Die Antwort verletzt das angeforderte Schema: ${problems.join('; ')}`);
  }

  return { text, json: payload, meta };
}

/** Sucht die letzte Zeile mit `type: "result"` im NDJSON-Strom. */
function findResultEvent(stdout: string): CliResultEvent | undefined {
  let found: CliResultEvent | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed) && parsed['type'] === 'result') found = parsed as CliResultEvent;
  }
  return found;
}

function buildMeta(
  event: CliResultEvent,
  request: LlmRequest,
  defaults: { readonly model: string; readonly durationMs: number },
): LlmCallMeta {
  const usage = isRecord(event.usage) ? event.usage : {};
  const input = asNumber(usage['input_tokens']);
  const cacheCreation = asNumber(usage['cache_creation_input_tokens']);
  const cacheRead = asNumber(usage['cache_read_input_tokens']);
  const output = asNumber(usage['output_tokens']);

  // Zwischengespeicherte Eingaben zaehlen mit: llm_call_log soll den echten
  // Umfang der Anfrage zeigen, nicht nur den nicht gecachten Rest.
  const promptTokens = sumOrNull([input, cacheCreation, cacheRead]);
  const totalTokens = sumOrNull([promptTokens, output]);

  return {
    provider: PROVIDER,
    model: pickModel(event.modelUsage) ?? (request.model || defaults.model),
    durationMs: defaults.durationMs,
    promptTokens,
    completionTokens: output,
    totalTokens,
  };
}

/**
 * Waehlt aus `modelUsage` das Modell mit den meisten Ausgabetokens. Die CLI
 * nutzt fuer Nebenaufgaben ein kleineres Modell mit; gemeint ist immer das,
 * das die Antwort geschrieben hat.
 */
function pickModel(modelUsage: unknown): string | undefined {
  if (!isRecord(modelUsage)) return undefined;
  let best: { name: string; tokens: number } | undefined;
  for (const [name, value] of Object.entries(modelUsage)) {
    const tokens = isRecord(value) ? (asNumber(value['outputTokens']) ?? 0) : 0;
    if (best === undefined || tokens > best.tokens) best = { name, tokens };
  }
  return best?.name;
}

/**
 * Ordnet eine Fehlermeldung der CLI einer Kategorie zu.
 *
 * Nicht erkannte Fehler werden bewusst **nicht** als `transient` eingestuft:
 * Bei unklarer Ursache wird nicht blind wiederholt (siehe ADR-0023).
 */
export function classifyCliFailure(message: string): LlmErrorKind {
  const text = message.toLowerCase();

  if (
    /not logged in|login expired|\/login|invalid api key|oauth|authenticate|credential/.test(text)
  )
    return 'auth';

  if (
    /session limit|weekly limit|opus limit|usage limit|rate limit|quota|429|too many requests/.test(
      text,
    )
  )
    return 'rate_limit';

  if (
    /overloaded|529|internal server error|5\d\d error|econnreset|enotfound|etimedout|socket hang up|network/.test(
      text,
    )
  )
    return 'transient';

  if (
    /not a valid json schema|invalid request|invalid model|model not found|unknown model|max_output_tokens|400/.test(
      text,
    )
  )
    return 'invalid';

  // Unbekannt: als nicht wiederholbar behandeln.
  return 'invalid';
}

function classify(cli: CliResult, message: string): LlmError {
  const clean = (message || '').trim();
  const kind = classifyCliFailure(clean);
  const prefix =
    kind === 'invalid' && clean === ''
      ? `Die Claude CLI brach ohne Meldung ab (Exit ${cli.exitCode ?? 'unbekannt'}).`
      : `Claude CLI (Exit ${cli.exitCode ?? 'unbekannt'}): ${excerpt(clean)}`;
  return fail(kind, prefix);
}

function spawnErrorMessage(spawnError: { code: string; message: string }): string {
  if (spawnError.code === 'ENOENT') {
    return (
      'Die Claude CLI wurde nicht gefunden. Pruefe LLM_CLI_PATH bzw. ob die CLI ' +
      'auf dem ausfuehrenden System installiert ist. Im Container laeuft der ' +
      'Aufruf ueber den Host-Runner (LLM_TRANSPORT=socket, siehe ADR-0022).'
    );
  }
  return `Die Claude CLI liess sich nicht starten (${spawnError.code}): ${spawnError.message}`;
}

function fail(kind: LlmErrorKind, message: string): LlmError {
  return new LlmError({ kind, provider: PROVIDER, message });
}

function excerpt(text: string, limit = 400): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
