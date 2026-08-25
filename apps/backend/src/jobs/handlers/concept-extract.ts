import { CONCEPT_TOPIC_AREAS } from '@gto/shared';
import type { ConceptSuggestion } from '@gto/shared';
import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { LlmSettingsReader } from '../../llm/settings.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { normalizeSuggestions } from '../../concept/normalize.js';
import {
  loadChapterSections,
  loadChapters,
  loadConceptIndex,
  persistConcepts,
  planChapterParts,
} from '../../concept/store.js';
import type { ChapterSection } from '../../concept/store.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Konzept-Extraktion je Kapitelteil (AP3.T3.2, Subtask 3).
 *
 * Ein Job verarbeitet **einen Teil eines Kapitels**, nicht das ganze Buch und
 * nicht eine einzelne Sektion:
 *
 * - Ein Lauf je Buch waere ein Riesen-Prompt und bei jedem Fehlschlag komplett
 *   zu wiederholen.
 * - Ein Lauf je Sektion saehe den Zusammenhang nicht und wuerde Gliederung
 *   statt Fachbegriffe liefern.
 *
 * Die Teilung erfolgt ueber ein Zeichenbudget (`planChapterParts`). Jeder Teil
 * bekommt die bereits bekannten Konzepte mit, damit Voraussetzungen ueber
 * Kapitelgrenzen hinweg gesetzt werden koennen und keine Dubletten entstehen.
 *
 * Der Aufruf laeuft ueber die Provider-Registry - Protokoll, Fehler-Taxonomie
 * und Retry aus AP2 greifen damit automatisch. Bei `rate_limit` legt der Worker
 * den Job wieder vor; die bereits geschriebenen Kapitel bleiben stehen.
 */

/** Kennung dieses Job-Typs. */
export const CONCEPT_EXTRACT_JOB = 'concept.extract';

export interface ConceptExtractPayload {
  /** Kapitelnummer 1-14. */
  readonly chapterNumber: number;
  /** Nummer des Teillaufs innerhalb des Kapitels, 1-basiert. */
  readonly part: number;
}

export interface ConceptExtractOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  readonly defaultModel: string;
  /**
   * Antwortgrenze. Ein Teillauf liefert bis zu ~12 Konzepte mit je einer
   * Kurzdefinition; die Antwort selbst bleibt klein. Grosszuegig gewaehlt,
   * weil die CLI nicht kuerzt, sondern abbricht (T2.2) und Modelle mit
   * innerem Ueberlegen deutlich mehr Tokens erzeugen, als die reine Antwort
   * vermuten laesst. Auf der CLI-Strecke ist dieser Wert die **tatsaechliche**
   * Obergrenze: Der Adapter setzt daraus `CLAUDE_CODE_MAX_OUTPUT_TOKENS` je
   * Aufruf und ueberschreibt die Umgebung des Host-Runners
   * (`src/llm/invocation.ts`).
   */
  readonly maxTokens?: number;
  readonly settings?: LlmSettingsReader;
}

const DEFAULT_MAX_TOKENS = 16384;

/**
 * Zielanzahl Konzepte je Teillauf, aus dem Textumfang abgeleitet.
 *
 * Kalibriert auf das Zielband von 120-200 Konzepten fuer das ganze Buch: rund
 * 620 000 Zeichen ergeben bei einem Budget von 15 000 Zeichen etwa 45
 * Teillaeufe; vier Konzepte je Lauf treffen die Mitte des Bandes. Die Grenzen
 * fangen sehr kurze und sehr lange Teillaeufe ab.
 */
export function targetConceptCount(chars: number): number {
  return Math.max(3, Math.min(8, Math.round(chars / 4000)));
}

/** Themenbereichsliste, wie sie im Prompt erscheint. */
export function renderTopicAreas(): string {
  return CONCEPT_TOPIC_AREAS.map((area) => `   - \`${area.id}\` — ${area.label}`).join('\n');
}

/** Sektionen als Prompt-Block mit woertlich zitierbaren Schluesseln. */
export function renderSections(sections: readonly ChapterSection[]): string {
  return sections
    .map((section) => `[sektion: ${section.sectionKey}] ${section.title}\n\n${section.body}`)
    .join('\n\n---\n\n');
}

/** Bekannte Konzepte als Prompt-Block. */
export function renderKnownConcepts(
  titles: readonly { title: string; chapterNumber: number }[],
): string {
  if (titles.length === 0) return '(noch keine)';
  return titles.map((entry) => `- ${entry.title} (Kapitel ${entry.chapterNumber})`).join('\n');
}

export function createConceptExtractJob(
  options: ConceptExtractOptions,
): JobType<ConceptExtractPayload> {
  return {
    type: CONCEPT_EXTRACT_JOB,

    parsePayload(raw: unknown): ConceptExtractPayload {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new JobPayloadError('Die Nutzlast muss ein Objekt sein.');
      }
      const candidate = raw as Record<string, unknown>;

      const chapterNumber = candidate['chapterNumber'];
      if (!Number.isInteger(chapterNumber) || (chapterNumber as number) < 1) {
        throw new JobPayloadError('Feld "chapterNumber" muss eine positive Ganzzahl sein.');
      }
      const part = candidate['part'];
      if (!Number.isInteger(part) || (part as number) < 1) {
        throw new JobPayloadError('Feld "part" muss eine positive Ganzzahl sein.');
      }

      return { chapterNumber: chapterNumber as number, part: part as number };
    },

    async run(payload, context): Promise<void> {
      const chapters = await loadChapters(context.db);
      const chapter = chapters.find((entry) => entry.chapterNumber === payload.chapterNumber);
      if (!chapter) {
        // Kein Retry-Fall: Ohne Buchimport hilft auch ein zweiter Versuch nicht.
        throw new JobPayloadError(
          `Kapitel ${payload.chapterNumber} existiert nicht. Erst "pnpm book:import" ausfuehren.`,
        );
      }

      const sections = await loadChapterSections(context.db, payload.chapterNumber);
      const parts = planChapterParts(sections);
      const group = parts[payload.part - 1];
      if (!group) {
        throw new JobPayloadError(
          `Kapitel ${payload.chapterNumber} hat nur ${parts.length} Teile, angefragt war Teil ${payload.part}.`,
        );
      }

      // Bekannte Konzepte: alles, was frueher schon entstanden ist - auch aus
      // frueheren Teilen desselben Kapitels. Damit greifen Dubletten-Erkennung
      // und kapiteluebergreifende Voraussetzungen.
      const index = await loadConceptIndex(context.db);
      const chars = group.reduce((sum, section) => sum + section.body.length, 0);

      const settings = await options.settings?.read();
      const timeoutMs = settings?.timeoutMs;

      const request = options.templates.renderRequest(
        'task/concept-taxonomy',
        {
          kapitel: `${chapter.chapterNumber} — ${chapter.title} (Teil ${payload.part} von ${parts.length})`,
          zielanzahl: String(targetConceptCount(chars)),
          themenbereiche: renderTopicAreas(),
          bekannte_konzepte: renderKnownConcepts(index.titles),
          abschnitte: renderSections(group),
        },
        {
          model: settings?.model ?? options.defaultModel,
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      );

      const provider = await options.providers.getActive();
      const response = await provider.complete(request);

      const suggestions = readSuggestions(response.json ?? response.text);
      const normalized = normalizeSuggestions(suggestions, new Set(index.bySlug.keys()));

      // Der Prompt nennt die Zielanzahl als Obergrenze und laesst nach
      // Wichtigkeit sortieren. Diese Kappung ist die deterministische
      // Rueckversicherung dazu: Ohne sie haengt die Groesse des Graphen daran,
      // wie streng ein Modell eine Zahl im Prompt nimmt - und damit auch, ob
      // das Ergebnis im Zielband von 120-200 Konzepten landet.
      const limit = targetConceptCount(chars);
      const kept = normalized.concepts.slice(0, limit);
      const dropped = normalized.concepts.length - kept.length;

      const result = await persistConcepts(context.db, payload.chapterNumber, kept);

      context.log(
        `Konzepte Kapitel ${payload.chapterNumber} Teil ${payload.part}: ` +
          `${result.inserted} neu, ${normalized.merged.length + result.mergedIntoExisting} Dubletten, ` +
          `${normalized.rejected.length} verworfen, ` +
          `${dropped} ueber Obergrenze ${limit} gekappt, ` +
          `${result.unresolvedPrerequisites} offene Voraussetzungen, ` +
          `${result.rejectedEdges} Kanten wegen Zyklus abgelehnt ` +
          `(${response.meta.provider}/${response.meta.model}, ${response.meta.durationMs} ms).`,
      );
    },
  };
}

/**
 * Liest die Vorschlagsliste aus der Antwort.
 *
 * Der Adapter liefert bei gesetztem `jsonSchema` bereits geparstes JSON; der
 * Textpfad ist die Rueckfallebene, falls ein Provider nur Text zurueckgibt.
 * Ein unbrauchbares Ergebnis ist ein `JobPayloadError` - ein zweiter Versuch
 * mit demselben Prompt wuerde dasselbe liefern.
 */
export function readSuggestions(source: unknown): ConceptSuggestion[] {
  let value = source;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new JobPayloadError('Die Antwort war kein JSON.');
    }
  }

  if (typeof value !== 'object' || value === null) {
    throw new JobPayloadError('Die Antwort war kein Objekt.');
  }

  const list = (value as { konzepte?: unknown }).konzepte;
  if (!Array.isArray(list)) {
    throw new JobPayloadError('Feld "konzepte" fehlt oder ist keine Liste.');
  }

  return list.filter(
    (entry): entry is ConceptSuggestion => typeof entry === 'object' && entry !== null,
  );
}
