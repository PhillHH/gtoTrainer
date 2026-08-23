import { spawn } from 'node:child_process';
import type { CliInvocation } from './invocation.js';

/**
 * Startet die CLI als Kindprozess und sammelt das Ergebnis ein.
 *
 * Bewusst ohne Shell (`shell: false` ist der Default von `spawn`): Argumente
 * gehen als Array, Prompt-Inhalte gehen ueber stdin. Damit ist kein
 * Prompt-Inhalt jemals als Shell-Kommando interpretierbar.
 */

/** Rohergebnis eines CLI-Laufs - noch nicht ausgewertet. */
export interface CliResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Wurde der Prozess wegen Zeitueberschreitung beendet? */
  readonly timedOut: boolean;
  /** Wanduhrzeit des Prozesslaufs in Millisekunden. */
  readonly durationMs: number;
  /** Gesetzt, wenn der Prozess gar nicht erst startete (z. B. ENOENT). */
  readonly spawnError?: { readonly code: string; readonly message: string };
}

export interface SpawnOptions {
  readonly cliPath: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /**
   * Frist zwischen freundlichem SIGTERM und hartem SIGKILL. Kurz gehalten:
   * Die CLI hat bis dahin bereits ihr Zeitbudget ausgeschoepft.
   */
  readonly killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Fuehrt den Aufruf aus. Wirft nicht - jeder Ausgang, auch ein gescheiterter
 * Prozessstart, kommt als `CliResult` zurueck. Die Zuordnung zur
 * Fehler-Taxonomie passiert eine Ebene hoeher.
 */
export function runCli(invocation: CliInvocation, options: SpawnOptions): Promise<CliResult> {
  const startedAt = Date.now();
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<CliResult>((resolve) => {
    const child = spawn(options.cliPath, [...invocation.args], {
      cwd: options.cwd,
      env: { ...invocation.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Eigene Prozessgruppe: Ein Kill erwischt auch Enkelprozesse, statt
      // verwaiste Kinder zurueckzulassen.
      detached: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      // Reagiert der Prozess nicht, wird nach der Frist hart beendet.
      killTimer = setTimeout(() => terminate('SIGKILL'), killGraceMs);
      killTimer.unref();
    }, options.timeoutMs);
    timeoutTimer.unref();

    /** Beendet die gesamte Prozessgruppe, nicht nur den direkten Kindprozess. */
    function terminate(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Prozess ist bereits weg - nichts zu tun.
        try {
          child.kill(signal);
        } catch {
          /* ebenfalls schon beendet */
        }
      }
    }

    function finish(result: Omit<CliResult, 'durationMs'>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        spawnError: { code: error.code ?? 'UNKNOWN', message: error.message },
      });
    });

    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });

    // stdin schliessen, sonst wartet die CLI im stream-json-Modus auf weitere
    // Nachrichten und der Aufruf laeuft in den Timeout.
    child.stdin.on('error', () => {
      /* Prozess bereits beendet - der Ausgang kommt ueber 'error'/'close'. */
    });
    child.stdin.end(invocation.stdin);
  });
}
