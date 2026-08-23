import type { LlmJsonSchema, LlmRequest } from '@gto/shared';

/**
 * Typen des Prompt-Template-Systems (AP2.T2.4).
 *
 * Prompts sind versionierte Dateien im Repo, keine Inline-Strings und keine
 * Datenbankinhalte: So sind sie reviewbar, diffbar und durch Golden-Tests
 * abgesichert.
 */

/** Wofuer ein Template da ist. */
export const TEMPLATE_KINDS = ['partial', 'persona', 'task'] as const;

/**
 * - `partial` - wiederverwendbarer Baustein, wird in andere Templates eingebunden.
 * - `persona` - System-Prompt, definiert Rolle und Verhalten.
 * - `task`    - konkrete Aufgabe; verweist ueber `system` auf eine Persona und
 *               liefert den Text der Benutzernachricht.
 */
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Kopfdaten eines Templates - im JSON-Block am Dateianfang (ADR-0025). */
export interface TemplateMeta {
  /** Eindeutige Kennung. Spiegelt konventionsgemaess den Dateipfad ohne Endung. */
  readonly id: string;
  /** Ganzzahl, wird bei inhaltlichen Aenderungen erhoeht. */
  readonly version: number;
  readonly kind: TemplateKind;
  /** Wozu das Template dient - eine Zeile, fuer Menschen. */
  readonly description: string;
  /** Platzhalter, die dieses Template selbst verwendet. */
  readonly placeholders: readonly string[];
  /** Nur bei `kind: 'task'`: Kennung der Persona, die zum System-Prompt wird. */
  readonly system?: string;
  /** Nur bei `kind: 'task'`: erzwingt eine strukturierte Antwort. */
  readonly jsonSchema?: LlmJsonSchema;
}

/** Ein geladenes Template mit aufgeloesten Partials. */
export interface LoadedTemplate {
  readonly meta: TemplateMeta;
  /** Quelldatei - erscheint in Fehlermeldungen. */
  readonly file: string;
  /**
   * Rumpf **nach** dem Einsetzen aller Partials. Enthaelt nur noch
   * Wert-Platzhalter, keine Partial-Verweise mehr.
   */
  readonly body: string;
  /**
   * Platzhalter, die im eigenen Rumpf vorkommen - eigene plus die der
   * eingebundenen Partials.
   */
  readonly bodyPlaceholders: readonly string[];
  /**
   * Alle Platzhalter, die ein Aufrufer uebergeben muss. Bei `task` ist das die
   * Vereinigung aus eigenem Rumpf und Persona; sonst dasselbe wie
   * {@link bodyPlaceholders}.
   */
  readonly requiredPlaceholders: readonly string[];
}

/** Werte, die beim Rendern eingesetzt werden. */
export type TemplateValues = Readonly<Record<string, string>>;

/**
 * Ergebnis von `renderRequest()`: ein vollstaendiger Provider-Request. Der
 * Aufrufer baut keine Strings mehr zusammen und setzt kein `system` von Hand.
 */
export type RenderedRequest = LlmRequest;

/** Fehler beim Laden oder Rendern eines Templates. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}
