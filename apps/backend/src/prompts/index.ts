/**
 * Prompt-Template-System (AP2.T2.4).
 *
 * Prompts sind versionierte Dateien unter `apps/backend/prompts/`, keine
 * Inline-Strings. Der Zugang laeuft ueber die {@link TemplateRegistry}; wie ein
 * Folge-AP ein Template anlegt und rendert, steht in docs/INTERFACES.md
 * Abschnitt 9.
 */
export { TemplateRegistry, PROMPTS_DIR, parseTemplateFile } from './registry.js';
export type { RenderOptions } from './registry.js';
export { TemplateError, TEMPLATE_KINDS } from './types.js';
export type {
  LoadedTemplate,
  RenderedRequest,
  TemplateKind,
  TemplateMeta,
  TemplateValues,
} from './types.js';
export { findValuePlaceholders } from './render.js';
