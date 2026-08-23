import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Gefaelschter Anthropic-Endpunkt fuer die Adapter- und Paritaetstests.
 *
 * Gegenstueck zu `fake-claude.mjs`: Beide werden ueber **dieselbe Direktive im
 * Prompt** gesteuert (`FAKE:<modus>|schluessel=wert`). Dadurch kann ein Test
 * denselben Request an beide Adapter schicken und die Ergebnisse vergleichen,
 * ohne pro Adapter eine eigene Inszenierung zu bauen.
 *
 * Kein Test hier spricht mit der echten API.
 */

/** Was der Server bei der letzten Anfrage gesehen hat. */
export interface SeenRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface FakeAnthropic {
  readonly baseUrl: string;
  /** Alle bisher empfangenen Anfragen, in Reihenfolge. */
  readonly seen: SeenRequest[];
  close(): Promise<void>;
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const seen: SeenRequest[] = [];
  const pending = new Set<() => void>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      seen.push({ body, headers: req.headers });

      const directive = parseDirective(raw);
      const respond = (
        status: number,
        payload: unknown,
        headers: Record<string, string> = {},
      ): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      switch (directive.mode) {
        case 'ok':
          respond(200, message([textBlock('OK')]));
          return;
        case 'json':
          respond(200, message([textBlock('{"farbe":"blau"}')]));
          return;
        case 'fence':
          respond(200, message([textBlock('```json\n{"farbe":"blau"}\n```')]));
          return;
        case 'wrapper':
          respond(
            200,
            message([
              textBlock(
                'Gerne! Hier das Ergebnis:\n{"farbe":"blau"}\nSag Bescheid, wenn du mehr brauchst.',
              ),
            ]),
          );
          return;
        case 'schema-violation':
          respond(200, message([textBlock('{"farbe":42}')]));
          return;
        case 'garbage':
          respond(200, message([textBlock('Dazu faellt mir nichts ein.')]));
          return;
        case 'multiblock':
          // Die API darf mehrere Textbloecke liefern - alle zaehlen.
          respond(200, message([textBlock('Teil eins. '), textBlock('Teil zwei.')]));
          return;
        case 'auth':
          respond(401, apiError('authentication_error', 'invalid x-api-key'));
          return;
        case 'ratelimit':
          respond(429, apiError('rate_limit_error', 'rate limit exceeded'), {
            'retry-after': '42',
          });
          return;
        case 'transient':
          respond(529, apiError('overloaded_error', 'Overloaded'));
          return;
        case 'invalid':
          respond(400, apiError('invalid_request_error', 'schema is not valid'));
          return;
        case 'unknown':
          // Ein Status, den die Zuordnung nicht kennt - darf nicht als
          // wiederholbar durchgehen.
          respond(418, apiError('teapot_error', 'unerwartet'));
          return;
        case 'slow': {
          const delay = Number(directive.options['delay'] ?? '200');
          const timer = setTimeout(() => {
            pending.delete(cancel);
            respond(200, message([textBlock('OK')]));
          }, delay);
          const cancel = (): void => {
            clearTimeout(timer);
            res.destroy();
          };
          pending.add(cancel);
          return;
        }
        case 'hang': {
          // Antwortet nie - der Adapter muss selbst abbrechen.
          const cancel = (): void => res.destroy();
          pending.add(cancel);
          return;
        }
        default:
          respond(
            400,
            apiError('invalid_request_error', `Unbekannter FAKE-Modus: ${directive.mode}`),
          );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      for (const cancel of pending) cancel();
      pending.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function textBlock(text: string): unknown {
  return { type: 'text', text };
}

function message(content: unknown[]): unknown {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 0,
    },
  };
}

function apiError(type: string, message: string): unknown {
  return { type: 'error', error: { type, message } };
}

function parseDirective(raw: string): { mode: string; options: Record<string, string> } {
  const match = /FAKE:([A-Za-z0-9|=/._-]+)/.exec(raw);
  if (match === null) return { mode: 'ok', options: {} };

  const [mode, ...pairs] = match[1]!.split('|');
  const options: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index > 0) options[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { mode: mode ?? 'ok', options };
}
