import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { LlmContent, LlmImageContent, LlmRequest } from '@gto/shared';
import { tryFindRepoRoot } from '../config/env.js';
import { assertValuesMatch, findTokens, findValuePlaceholders, renderBody } from './render.js';
import { TEMPLATE_KINDS, TemplateError } from './types.js';
import type {
  LoadedTemplate,
  RenderedRequest,
  TemplateKind,
  TemplateMeta,
  TemplateValues,
} from './types.js';

/**
 * Datei-basierte Template-Registry (AP2.T2.4).
 *
 * Templates liegen als `.md`-Dateien unter `apps/backend/prompts/`, mit einem
 * JSON-Block als Kopfdaten. Beim Laden werden Partials eingesetzt und die
 * Platzhalter gegen die Deklaration geprueft — ein Tippfehler faellt damit
 * beim Start auf, nicht erst beim ersten Aufruf.
 *
 * Verwendung in Folge-APs: siehe docs/INTERFACES.md, Abschnitt 9.
 */

/**
 * Verzeichnis der Templates.
 *
 * Im Repo `apps/backend/prompts`. Im Container gibt es keine Repo-Struktur;
 * dort zeigt `PROMPTS_DIR` direkt auf das Verzeichnis - dieselbe Mechanik wie
 * bei `MIGRATIONS_DIR`.
 */
export const PROMPTS_DIR =
  process.env['PROMPTS_DIR'] ?? resolve(tryFindRepoRoot() ?? process.cwd(), 'apps/backend/prompts');

/** Obergrenze der Partial-Verschachtelung - Schutz vor Endlosrekursion. */
const MAX_PARTIAL_DEPTH = 10;

/** Zusaetzliche Angaben, die nicht aus dem Template kommen. */
export interface RenderOptions {
  readonly model: string;
  readonly maxTokens: number;
  readonly timeoutMs?: number;
  /**
   * Bildbausteine, die hinter dem Aufgabentext an die Nachricht gehaengt
   * werden (AP3.T3.3, Vision).
   *
   * Der Request wird bewusst auch fuer Vision **hier** gebaut und nicht beim
   * Aufrufer zusammengesteckt: Sonst gaebe es zwei Stellen, an denen ein
   * Provider-Request entsteht, und die Regel "Prompts sind Dateien" haette ein
   * Schlupfloch. Das Bild selbst ist keine Prompt-Fassung, sondern Nutzlast -
   * es gehoert nicht in die Template-Datei.
   */
  readonly images?: readonly LlmImageContent[];
}

export class TemplateRegistry {
  readonly #templates: ReadonlyMap<string, LoadedTemplate>;

  constructor(templates: ReadonlyMap<string, LoadedTemplate>) {
    this.#templates = templates;
  }

  /** Liest alle Templates eines Verzeichnisses ein. */
  static load(directory: string = PROMPTS_DIR): TemplateRegistry {
    return new TemplateRegistry(loadTemplates(directory));
  }

  /** Alle bekannten Kennungen, sortiert - fuer Diagnose und Tests. */
  ids(): readonly string[] {
    return [...this.#templates.keys()].sort();
  }

  /** Ein Template. Wirft bei unbekannter Kennung. */
  get(id: string): LoadedTemplate {
    const template = this.#templates.get(id);
    if (template === undefined) {
      throw new TemplateError(
        `Unbekanntes Template "${id}". Bekannt sind: ${this.ids().join(', ')}.`,
      );
    }
    return template;
  }

  /** Rendert ein einzelnes Template zu Text (Partial, Persona oder Aufgabenrumpf). */
  renderText(id: string, values: TemplateValues = {}): string {
    const template = this.get(id);
    return renderBody(id, template.body, template.bodyPlaceholders, values);
  }

  /**
   * Rendert ein `task`-Template zu einem **fertigen** `LLMProvider`-Request.
   *
   * Der System-Prompt kommt aus der verwiesenen Persona, der Rumpf wird zur
   * Benutzernachricht, ein hinterlegtes `jsonSchema` wird uebernommen. Der
   * Aufrufer ergaenzt nur noch Modell und Token-Grenze.
   */
  renderRequest(id: string, values: TemplateValues, options: RenderOptions): RenderedRequest {
    const template = this.get(id);
    if (template.meta.kind !== 'task') {
      throw new TemplateError(
        `Template "${id}" ist vom Typ "${template.meta.kind}". Nur "task"-Templates lassen sich ` +
          `zu einem Provider-Request rendern; nutze fuer die anderen renderText().`,
      );
    }

    const systemId = template.meta.system as string;
    const persona = this.get(systemId);

    // Aufgabe und Persona teilen sich einen Wertesatz. Deshalb wird einmal
    // strikt gegen die Vereinigung geprueft - ein Tippfehler faellt hier auf,
    // nicht erst in einer der beiden Haelften.
    assertValuesMatch(id, template.requiredPlaceholders, values);

    const system = renderBody(
      systemId,
      persona.body,
      persona.bodyPlaceholders,
      pick(values, persona.bodyPlaceholders),
    );
    const text = renderBody(
      id,
      template.body,
      template.bodyPlaceholders,
      pick(values, template.bodyPlaceholders),
    );

    const content: LlmContent[] = [{ type: 'text', text }];
    for (const image of options.images ?? []) content.push(image);

    const request: LlmRequest = {
      system,
      messages: [{ role: 'user', content }],
      model: options.model,
      maxTokens: options.maxTokens,
      ...(template.meta.jsonSchema === undefined ? {} : { jsonSchema: template.meta.jsonSchema }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    return request;
  }
}

/* -------------------------------------------------------------------------
 * Laden
 * ---------------------------------------------------------------------- */

interface RawTemplate {
  readonly meta: TemplateMeta;
  readonly file: string;
  readonly body: string;
}

function loadTemplates(directory: string): ReadonlyMap<string, LoadedTemplate> {
  const raw = new Map<string, RawTemplate>();

  for (const file of listMarkdownFiles(directory)) {
    const parsed = parseFile(file, relative(directory, file));
    const existing = raw.get(parsed.meta.id);
    if (existing !== undefined) {
      throw new TemplateError(
        `Doppelte Template-Kennung "${parsed.meta.id}": ${existing.file} und ${parsed.file}. ` +
          `Kennungen muessen eindeutig sein; es wird nichts stillschweigend ueberschrieben.`,
      );
    }
    raw.set(parsed.meta.id, parsed);
  }

  const loaded = new Map<string, LoadedTemplate>();
  for (const [id, template] of raw) {
    loaded.set(id, finalize(template, raw));
  }

  // Verweise auf Personas erst pruefen, wenn alle Templates bekannt sind. Ein
  // Task uebernimmt dabei die Platzhalter seiner Persona in sein Pflichtset -
  // Autoren muessen sie nicht doppelt deklarieren.
  const resolved = new Map<string, LoadedTemplate>();
  for (const [id, template] of loaded) {
    resolved.set(id, withPersonaPlaceholders(template, loaded));
  }
  return resolved;
}

/** Setzt Partials ein und ermittelt die tatsaechlich benoetigten Platzhalter. */
function finalize(template: RawTemplate, all: ReadonlyMap<string, RawTemplate>): LoadedTemplate {
  const body = expandPartials(template, all, [template.meta.id]);
  const used = findValuePlaceholders(body);
  const declared = new Set(template.meta.placeholders);

  const undeclared = used.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new TemplateError(
      `Template "${template.meta.id}" (${template.file}) verwendet die Platzhalter ` +
        `${undeclared.map((n) => `"${n}"`).join(', ')}, deklariert sie aber nicht in "placeholders". ` +
        `Auch Platzhalter aus eingebundenen Partials muessen deklariert werden.`,
    );
  }

  const unused = template.meta.placeholders.filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new TemplateError(
      `Template "${template.meta.id}" (${template.file}) deklariert die Platzhalter ` +
        `${unused.map((n) => `"${n}"`).join(', ')}, verwendet sie aber nirgends.`,
    );
  }

  return {
    meta: template.meta,
    file: template.file,
    body,
    bodyPlaceholders: used,
    requiredPlaceholders: used,
  };
}

/** Ersetzt `{{> id}}` rekursiv; bricht bei Zyklen und zu tiefer Schachtelung ab. */
function expandPartials(
  template: RawTemplate,
  all: ReadonlyMap<string, RawTemplate>,
  chain: readonly string[],
): string {
  if (chain.length > MAX_PARTIAL_DEPTH) {
    throw new TemplateError(
      `Partials sind zu tief verschachtelt (mehr als ${MAX_PARTIAL_DEPTH} Ebenen): ${chain.join(' -> ')}.`,
    );
  }

  let body = template.body;
  for (const token of findTokens(template.body)) {
    if (token.kind !== 'partial') continue;

    if (chain.includes(token.name)) {
      throw new TemplateError(`Partial-Zyklus erkannt: ${[...chain, token.name].join(' -> ')}.`);
    }

    const partial = all.get(token.name);
    if (partial === undefined) {
      throw new TemplateError(
        `Template "${template.meta.id}" (${template.file}) bindet das unbekannte Partial ` +
          `"${token.name}" ein.`,
      );
    }
    if (partial.meta.kind !== 'partial') {
      throw new TemplateError(
        `Template "${template.meta.id}" bindet "${token.name}" als Partial ein, dieses ist aber ` +
          `vom Typ "${partial.meta.kind}".`,
      );
    }

    const expanded = expandPartials(partial, all, [...chain, token.name]);
    body = body.split(`{{> ${token.name}}}`).join(expanded);
  }
  return body;
}

/**
 * Prueft den Persona-Verweis eines Tasks und ergaenzt dessen Platzhalter.
 * Andere Template-Arten duerfen kein `system` setzen.
 */
function withPersonaPlaceholders(
  template: LoadedTemplate,
  all: ReadonlyMap<string, LoadedTemplate>,
): LoadedTemplate {
  if (template.meta.kind !== 'task') {
    if (template.meta.system !== undefined) {
      throw new TemplateError(
        `Template "${template.meta.id}" ist vom Typ "${template.meta.kind}" und darf kein "system" setzen.`,
      );
    }
    return template;
  }

  const systemId = template.meta.system;
  if (systemId === undefined) {
    throw new TemplateError(
      `Task-Template "${template.meta.id}" (${template.file}) muss ueber "system" auf eine Persona verweisen.`,
    );
  }
  const persona = all.get(systemId);
  if (persona === undefined) {
    throw new TemplateError(
      `Task-Template "${template.meta.id}" verweist auf die unbekannte Persona "${systemId}".`,
    );
  }
  if (persona.meta.kind !== 'persona') {
    throw new TemplateError(
      `Task-Template "${template.meta.id}" verweist mit "system" auf "${systemId}", das aber vom ` +
        `Typ "${persona.meta.kind}" ist.`,
    );
  }

  const extra = persona.bodyPlaceholders.filter(
    (name) => !template.bodyPlaceholders.includes(name),
  );
  if (extra.length === 0) return template;

  return { ...template, requiredPlaceholders: [...template.bodyPlaceholders, ...extra] };
}

/* -------------------------------------------------------------------------
 * Dateien lesen
 * ---------------------------------------------------------------------- */

function listMarkdownFiles(directory: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw new TemplateError(
      `Template-Verzeichnis "${directory}" ist nicht lesbar: ${describe(error)}. ` +
        `Im Container muss PROMPTS_DIR auf das eingebundene Verzeichnis zeigen.`,
    );
  }

  const files: string[] = [];
  for (const entry of [...entries].sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...listMarkdownFiles(full));
    else if (entry.endsWith('.md')) files.push(full);
  }
  return files;
}

/**
 * Zerlegt eine Datei in Kopfdaten und Rumpf.
 *
 * Aufbau: eine Zeile `---`, dann ein JSON-Objekt, dann wieder `---`, dann der
 * Rumpf. JSON statt YAML, weil es ohne Dependency parsbar ist und das optionale
 * `jsonSchema` unveraendert aufnehmen kann (ADR-0025).
 */
export function parseTemplateFile(source: string, file: string): RawTemplate {
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (match === null) {
    throw new TemplateError(
      `Template ${file}: Kopfdaten fehlen. Erwartet wird ein JSON-Objekt zwischen zwei Zeilen "---" ` +
        `am Dateianfang.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] as string);
  } catch (error) {
    throw new TemplateError(
      `Template ${file}: Kopfdaten sind kein gueltiges JSON (${describe(error)}).`,
    );
  }

  return {
    meta: assertMeta(parsed, file),
    file,
    body: normalized.slice(match[0].length).trim(),
  };
}

function parseFile(fullPath: string, relativePath: string): RawTemplate {
  return parseTemplateFile(readFileSync(fullPath, 'utf8'), relativePath.split(sep).join('/'));
}

function assertMeta(value: unknown, file: string): TemplateMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TemplateError(`Template ${file}: Kopfdaten sind kein Objekt.`);
  }
  const raw = value as Record<string, unknown>;

  const id = requireString(raw['id'], 'id', file);
  const description = requireString(raw['description'], 'description', file);
  const kind = requireString(raw['kind'], 'kind', file);
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
    throw new TemplateError(
      `Template ${file}: "kind" muss eines von ${TEMPLATE_KINDS.join(', ')} sein, ist "${kind}".`,
    );
  }

  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new TemplateError(`Template ${file}: "version" muss eine ganze Zahl >= 1 sein.`);
  }

  const placeholders = raw['placeholders'];
  if (!Array.isArray(placeholders) || placeholders.some((name) => typeof name !== 'string')) {
    throw new TemplateError(
      `Template ${file}: "placeholders" muss eine Liste von Zeichenketten sein (notfalls leer).`,
    );
  }

  const system = raw['system'];
  if (system !== undefined && typeof system !== 'string') {
    throw new TemplateError(`Template ${file}: "system" muss eine Template-Kennung sein.`);
  }

  const jsonSchema = raw['jsonSchema'];
  if (jsonSchema !== undefined && (typeof jsonSchema !== 'object' || jsonSchema === null)) {
    throw new TemplateError(`Template ${file}: "jsonSchema" muss ein Objekt sein.`);
  }

  return {
    id,
    version,
    kind: kind as TemplateKind,
    description,
    placeholders: placeholders as readonly string[],
    ...(system === undefined ? {} : { system }),
    ...(jsonSchema === undefined ? {} : { jsonSchema: jsonSchema as Record<string, unknown> }),
  };
}

function requireString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TemplateError(`Template ${file}: "${field}" fehlt oder ist leer.`);
  }
  return value;
}

function pick(values: TemplateValues, names: readonly string[]): TemplateValues {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = values[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
