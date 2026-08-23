import type { LlmContent, LlmRequest } from '@gto/shared';

/**
 * Uebersetzt einen `LlmRequest` in einen konkreten CLI-Aufruf.
 *
 * Die Aufrufform folgt ADR-0021 und dem Nachtrag in ADR-0023: **immer**
 * `--input-format stream-json`, damit Text- und Bildaufrufe denselben Weg
 * nehmen und der Prompt nie auf der Kommandozeile steht.
 */

/** Alles, was der Prozessstart braucht - ohne Shell, ohne String-Verkettung. */
export interface CliInvocation {
  readonly args: readonly string[];
  /** Wird auf stdin geschrieben; danach wird stdin geschlossen. */
  readonly stdin: string;
  /** Vollstaendiges Prozess-Environment (kein Erben des Eltern-Environments). */
  readonly env: Readonly<Record<string, string>>;
}

/** Eingaben, die nicht aus dem Request kommen, sondern aus der Konfiguration. */
export interface InvocationContext {
  readonly claudeConfigDir: string;
  /** Modell, falls der Request keines vorgibt. */
  readonly defaultModel: string;
}

/**
 * Baut den Aufruf. Prompt-Inhalte landen ausschliesslich in `stdin`; auf der
 * Kommandozeile stehen nur Flags, Modellname, System-Prompt und - falls
 * gesetzt - das JSON-Schema.
 */
export function buildInvocation(request: LlmRequest, context: InvocationContext): CliInvocation {
  const model = request.model.trim() === '' ? context.defaultModel : request.model;

  const args = [
    '-p',
    '--model',
    model,
    // Ersetzt den Coding-Agenten-Prompt durch die Persona des Aufrufers. Das
    // ist die woertliche Bedeutung von LlmRequest.system.
    '--system-prompt',
    request.system,
    // Kein Werkzeugzugriff: Das Gateway will eine Antwort, keinen Agenten.
    // Spart nachweislich ~18.000 Eingabetokens je Aufruf (siehe ADR-0023).
    '--tools',
    '',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (request.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(request.jsonSchema));
  }

  return {
    args,
    stdin: `${JSON.stringify(buildUserMessage(request))}\n`,
    env: buildEnv(request, context),
  };
}

/**
 * Bewusst **minimales** Environment: Das Eltern-Environment wird nicht blind
 * durchgereicht. Insbesondere `ANTHROPIC_API_KEY` bleibt draussen - laut
 * Dokumentation wuerde die CLI ihn im `-p`-Modus immer der Subscription
 * vorziehen und damit still am Profil vorbei abrechnen.
 */
function buildEnv(
  request: LlmRequest,
  context: InvocationContext,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: context.claudeConfigDir,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens),
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  };
  const home = process.env['HOME'];
  if (home !== undefined) env['HOME'] = home;
  return env;
}

/**
 * Faltet den Verlauf in **eine** Nachricht.
 *
 * Der Streaming-Input der CLI kennt nur Nachrichten der Rolle `user`; ein
 * Assistant-Turn laesst sich nicht einspielen. Bei mehr als einer Nachricht
 * werden die Rollen deshalb als Textmarken vorangestellt. Bei einer einzelnen
 * Nachricht - dem Regelfall des Gateways - passiert nichts dergleichen.
 */
function buildUserMessage(request: LlmRequest): unknown {
  const withLabels = request.messages.length > 1;
  const content = request.messages.flatMap((message) => {
    const blocks = message.content.map(toCliBlock);
    if (!withLabels) return blocks;
    return [{ type: 'text', text: `[${message.role}]` }, ...blocks];
  });

  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

function toCliBlock(block: LlmContent): unknown {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  };
}
