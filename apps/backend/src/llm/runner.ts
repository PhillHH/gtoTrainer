import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmRequest } from '@gto/shared';
import { LlmError } from './errors.js';
import { buildInvocation } from './invocation.js';
import type { InvocationContext } from './invocation.js';
import { runCli } from './spawn.js';
import type { CliResult, SpawnOptions } from './spawn.js';

/**
 * Host-seitiger CLI-Runner und sein Gegenstueck im Container (ADR-0022).
 *
 * Der Container erreicht die Claude CLI nicht selbst: Sie liegt samt Profil B
 * auf dem Host. Statt das Profil in den Container zu haengen, laeuft auf dem
 * Host ein kleiner Prozess, der die CLI ausfuehrt und ueber einen
 * Unix-Domain-Socket erreichbar ist.
 *
 * **Der Client bestimmt nur den Inhalt der Anfrage.** Aufrufform,
 * Werkzeugfreigaben, Arbeitsverzeichnis, Profilpfad und die Timeout-Obergrenze
 * legt allein der Runner fest. Ein kompromittierter Container kann darueber
 * also nichts anderes tun als einen Prompt einreichen.
 */

/** Protokollversion. Steigt, sobald sich die Form der Nachrichten aendert. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Obergrenze einer Anfragezeile - Bild-Requests sind gross, aber nicht beliebig. */
export const RUNNER_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Anfrage des Containers an den Runner. */
export interface RunnerRequest {
  readonly v: number;
  readonly request: LlmRequest;
  readonly timeoutMs: number;
}

/** Antwort des Runners: entweder das Rohergebnis der CLI oder ein Protokollfehler. */
export type RunnerResponse =
  | { readonly ok: true; readonly result: CliResult }
  | { readonly ok: false; readonly message: string };

export interface RunnerOptions {
  readonly socketPath: string;
  readonly invocation: InvocationContext;
  readonly spawn: Omit<SpawnOptions, 'timeoutMs'>;
  /** Obergrenze, die ein Client nicht ueberschreiten darf. */
  readonly maxTimeoutMs: number;
  /** Wird fuer jede Anfrage aufgerufen - der Runner selbst loggt nicht. */
  readonly onEvent?: (event: RunnerEvent) => void;
}

export type RunnerEvent =
  | { readonly type: 'listening'; readonly socketPath: string }
  | { readonly type: 'call'; readonly model: string; readonly durationMs: number }
  | { readonly type: 'error'; readonly message: string };

/**
 * Startet den Runner. Der Socket bekommt Mode `0600`: Er ist damit nur fuer den
 * Benutzer erreichbar, unter dem der Runner laeuft - im Container ist das
 * dieselbe uid (1000).
 */
export async function startRunner(options: RunnerOptions): Promise<Server> {
  mkdirSync(dirname(options.socketPath), { recursive: true });
  // Ein Socket aus einem abgestuerzten Vorlauf wuerde EADDRINUSE ausloesen.
  rmSync(options.socketPath, { force: true });

  const server = createServer((socket) => {
    handleConnection(socket, options).catch((error: unknown) => {
      options.onEvent?.({ type: 'error', message: describeError(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  chmodSync(options.socketPath, 0o600);
  options.onEvent?.({ type: 'listening', socketPath: options.socketPath });
  return server;
}

async function handleConnection(socket: Socket, options: RunnerOptions): Promise<void> {
  let payload: RunnerRequest;
  try {
    payload = parseRequest(await readLine(socket, RUNNER_MAX_REQUEST_BYTES));
  } catch (error) {
    respond(socket, { ok: false, message: describeError(error) });
    return;
  }

  const timeoutMs = Math.min(payload.timeoutMs, options.maxTimeoutMs);
  const invocation = buildInvocation(payload.request, options.invocation);
  const result = await runCli(invocation, { ...options.spawn, timeoutMs });

  options.onEvent?.({
    type: 'call',
    model: payload.request.model,
    durationMs: result.durationMs,
  });
  respond(socket, { ok: true, result });
}

function parseRequest(line: string): RunnerRequest {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Anfrage ist kein Objekt.');
  }
  const candidate = parsed as Partial<RunnerRequest>;
  if (candidate.v !== RUNNER_PROTOCOL_VERSION) {
    throw new Error(
      `Protokollversion ${String(candidate.v)} passt nicht zu ${RUNNER_PROTOCOL_VERSION}. Runner und Backend muessen zusammen aktualisiert werden.`,
    );
  }
  if (typeof candidate.request !== 'object' || candidate.request === null) {
    throw new Error('Feld "request" fehlt.');
  }
  if (typeof candidate.timeoutMs !== 'number' || candidate.timeoutMs <= 0) {
    throw new Error('Feld "timeoutMs" fehlt oder ist ungueltig.');
  }
  return { v: candidate.v, request: candidate.request, timeoutMs: candidate.timeoutMs };
}

function respond(socket: Socket, response: RunnerResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

/* -------------------------------------------------------------------------
 * Client-Seite (laeuft im Container)
 * ---------------------------------------------------------------------- */

/**
 * Reicht einen Request an den Runner weiter und gibt dessen Rohergebnis
 * zurueck. Die Auswertung passiert wie beim direkten Aufruf im Provider -
 * beide Transportwege muenden in denselben `CliResult`.
 */
export async function callRunner(
  socketPath: string,
  request: LlmRequest,
  timeoutMs: number,
): Promise<CliResult> {
  const socket = await connectSocket(socketPath);
  try {
    socket.write(`${JSON.stringify({ v: RUNNER_PROTOCOL_VERSION, request, timeoutMs })}\n`);
    // Grosszuegiger als das Aufruf-Timeout: Der Runner beendet die CLI selbst
    // und soll noch antworten koennen.
    const line = await readLine(socket, RUNNER_MAX_REQUEST_BYTES, timeoutMs + 30_000);
    const response = JSON.parse(line) as RunnerResponse;
    if (!response.ok) {
      throw new LlmError({
        kind: 'invalid',
        provider: 'cli',
        message: `Der CLI-Runner hat die Anfrage abgelehnt: ${response.message}`,
      });
    }
    return response.result;
  } finally {
    socket.destroy();
  }
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);

    function onError(error: NodeJS.ErrnoException): void {
      socket.destroy();
      reject(
        new LlmError({
          kind: 'auth',
          provider: 'cli',
          message:
            `Der CLI-Runner ist unter ${socketPath} nicht erreichbar (${error.code ?? error.message}). ` +
            'Laeuft er auf dem Host? Start: `pnpm llm:runner` (siehe RUNBOOK 9.2).',
        }),
      );
    }
  });
}

/** Liest genau eine Zeile vom Socket und beachtet dabei eine Groessengrenze. */
function readLine(socket: Socket, maxBytes: number, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Der CLI-Runner hat nicht innerhalb von ${timeoutMs} ms geantwortet.`));
      }, timeoutMs);
      timer.unref();
    }

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
    }

    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        reject(new Error(`Anfrage groesser als ${maxBytes} Bytes.`));
        return;
      }
      chunks.push(chunk);
      const joined = Buffer.concat(chunks).toString('utf8');
      const newline = joined.indexOf('\n');
      if (newline >= 0) {
        cleanup();
        resolve(joined.slice(0, newline));
      }
    }

    function onEnd(): void {
      cleanup();
      const joined = Buffer.concat(chunks).toString('utf8').trim();
      if (joined === '') reject(new Error('Verbindung ohne Antwort beendet.'));
      else resolve(joined);
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
