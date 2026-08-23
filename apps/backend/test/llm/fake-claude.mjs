#!/usr/bin/env node
/**
 * Gefaelschte Claude CLI fuer die Adapter-Tests.
 *
 * Verhaelt sich wie `claude -p --input-format stream-json --output-format
 * stream-json`: liest eine stream-json-Zeile von stdin und schreibt NDJSON auf
 * stdout.
 *
 * **Gesteuert wird sie ueber den Prompt selbst**, nicht ueber Umgebungs-
 * variablen: Der Adapter baut bewusst ein minimales Prozess-Environment, in dem
 * eine Testvariable gar nicht ankaeme. Der Test schreibt deshalb eine Direktive
 * in den Prompttext:
 *
 *   FAKE:auth
 *   FAKE:slow|delay=200|trace=/tmp/x
 *   FAKE:flaky|counter=/tmp/c|fail=2
 *
 * Damit sind Parsing, Timeout, Fehlerzuordnung, Retry und Semaphore ohne echte
 * Subscription pruefbar - kein Test verbraucht Kontingent.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const stdin = readStdin();
const directive = parseDirective(stdin);
const mode = directive.mode;
const trace = directive.options['trace'];

if (trace !== undefined) appendFileSync(trace, 'S\n');

switch (mode) {
  case 'ok':
    succeed({ result: 'OK' });
    break;

  case 'json':
    succeed({ result: '{"farbe":"blau"}', structured_output: { farbe: 'blau' } });
    break;

  case 'fence':
    // Kein structured_output: Die Nutzlast steckt in einem Code-Fence.
    succeed({ result: '```json\n{"farbe":"blau"}\n```' });
    break;

  case 'wrapper':
    succeed({
      result: 'Gerne! Hier das Ergebnis:\n{"farbe":"blau"}\nSag Bescheid, wenn du mehr brauchst.',
    });
    break;

  case 'schema-violation':
    succeed({ result: '{"farbe":42}', structured_output: { farbe: 42 } });
    break;

  case 'garbage':
    succeed({ result: 'Dazu faellt mir nichts ein.' });
    break;

  case 'no-result':
    emit({ type: 'system', subtype: 'init' });
    process.exit(0);
    break;

  case 'echo-args':
    // Belegt, was tatsaechlich bei der CLI ankam: Environment, Argumente, cwd.
    succeed({
      result: JSON.stringify({
        claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] ?? null,
        hasAnthropicApiKey: process.env['ANTHROPIC_API_KEY'] !== undefined,
        maxOutputTokens: process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] ?? null,
        envKeys: Object.keys(process.env).sort(),
        argv: process.argv.slice(2),
        stdinBytes: stdin.length,
        cwd: process.cwd(),
      }),
    });
    break;

  case 'auth':
    failWith('Not logged in · Please run /login');
    break;

  case 'ratelimit':
    failWith("You've hit your session limit · resets 3:45pm");
    break;

  case 'transient':
    failWith('API Error: 529 overloaded_error');
    break;

  case 'invalid':
    failWith('Error: --json-schema is not a valid JSON Schema', { onStderr: true });
    break;

  case 'unknown':
    failWith('Es ist etwas Unerwartetes passiert.');
    break;

  case 'flaky': {
    // Scheitert transient, bis `fail` Versuche verbraucht sind.
    const counter = directive.options['counter'];
    const failTimes = Number(directive.options['fail'] ?? '1');
    const attempt = counter === undefined ? 1 : bumpCounter(counter);
    if (attempt <= failTimes) failWith('API Error: 529 overloaded_error');
    succeed({ result: `OK nach Versuch ${attempt}` });
    break;
  }

  case 'always-auth': {
    const counter = directive.options['counter'];
    if (counter !== undefined) bumpCounter(counter);
    failWith('Not logged in · Please run /login');
    break;
  }

  case 'always-parse': {
    const counter = directive.options['counter'];
    if (counter !== undefined) bumpCounter(counter);
    succeed({ result: 'Kein JSON weit und breit.' });
    break;
  }

  case 'always-invalid': {
    const counter = directive.options['counter'];
    if (counter !== undefined) bumpCounter(counter);
    failWith('Error: --json-schema is not a valid JSON Schema', { onStderr: true });
    break;
  }

  case 'slow': {
    const delay = Number(directive.options['delay'] ?? '200');
    setTimeout(() => {
      if (trace !== undefined) appendFileSync(trace, 'E\n');
      succeed({ result: 'OK' });
    }, delay);
    break;
  }

  case 'hang':
    // Antwortet nie - der Adapter muss den Prozess selbst beenden.
    setInterval(() => {}, 1000);
    break;

  default:
    process.stderr.write(`Unbekannter FAKE-Modus: ${mode}\n`);
    process.exit(2);
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

function resultEvent(fields) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    session_id: 'fake-session',
    num_turns: 1,
    duration_ms: 12,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 2 },
      'claude-sonnet-5': { outputTokens: 7 },
    },
    api_error_status: null,
    ...fields,
  };
}

function succeed(fields) {
  // Die echte CLI schickt vor dem Ergebnis weitere Ereignisse - der Parser
  // muss sie ueberspringen.
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session' });
  emit(resultEvent(fields));
  process.exit(0);
}

function failWith(message, options = {}) {
  if (options.onStderr === true) {
    process.stderr.write(`${message}\n`);
  } else {
    emit(resultEvent({ is_error: true, result: message, terminal_reason: 'api_error' }));
  }
  process.exit(1);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Liest `FAKE:<modus>|schluessel=wert|…` aus dem ersten Textblock des Prompts. */
function parseDirective(raw) {
  const match = /FAKE:([A-Za-z0-9|=/._-]+)/.exec(raw);
  if (match === null) return { mode: 'ok', options: {} };

  const [mode, ...pairs] = match[1].split('|');
  const options = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index > 0) options[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { mode, options };
}

function bumpCounter(path) {
  let value = 0;
  try {
    value = Number(readFileSync(path, 'utf8')) || 0;
  } catch {
    value = 0;
  }
  value += 1;
  writeFileSync(path, String(value));
  return value;
}
