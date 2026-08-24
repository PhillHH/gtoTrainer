import { isConceptLevel, isConceptTopicArea } from '@gto/shared';
import type { ConceptLevel, ConceptSuggestion, ConceptTopicArea } from '@gto/shared';

/**
 * Normalisierung und Dubletten-Erkennung der KI-Vorschlaege (AP3.T3.2,
 * Subtask 5).
 *
 * **Deterministisch, ohne KI.** Was sich mit einer Regel entscheiden laesst,
 * wird mit einer Regel entschieden - das Modell schlaegt vor, der Code raeumt
 * auf. Ein zweites Modell zur Pruefung des ersten waere teurer und weniger
 * reproduzierbar.
 */

/** Ein geprueefter Vorschlag, bereit zum Persistieren. */
export interface NormalizedConcept {
  /** Fachlicher Schluessel: normalisierter Titel. */
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly topicArea: ConceptTopicArea;
  readonly minLevel: ConceptLevel;
  /** Titel-Referenzen auf Voraussetzungen, noch nicht aufgeloest. */
  readonly prerequisiteTitles: readonly string[];
  /** Sektionsschluessel aus T3.1, wie vom Modell genannt. */
  readonly sectionKeys: readonly string[];
}

/** Warum ein Vorschlag verworfen oder zusammengefuehrt wurde. */
export interface NormalizeRejection {
  readonly title: string;
  readonly reason: string;
}

export interface NormalizeResult {
  readonly concepts: readonly NormalizedConcept[];
  /** Vorschlaege, die mit einem bereits vorhandenen zusammengefuehrt wurden. */
  readonly merged: readonly NormalizeRejection[];
  /** Vorschlaege, die verworfen wurden (unbrauchbar oder unbekannte Werte). */
  readonly rejected: readonly NormalizeRejection[];
}

/**
 * Vergleichsform eines Konzepttitels.
 *
 * Bewusst aggressiv: Gross-/Kleinschreibung, Bindestriche, Klammerzusaetze und
 * fuehrende Artikel verschwinden. „Die Minimum Defense Frequency (MDF)" und
 * „minimum defense frequency" sind dasselbe Konzept - genau das soll die
 * Dubletten-Erkennung ueber Kapitelgrenzen hinweg treffen.
 */
export function conceptSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      // Alles Uebrige entakzentuieren: NFD zerlegt in Grundzeichen plus
      // kombinierendes Zeichen, das dann wegfaellt.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^(der|die|das|the|a|an)-/, '')
  );
}

/** Kuerzt Leerraum und schneidet auf eine Hoechstlaenge. */
function tidy(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength
    ? collapsed
    : `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Obergrenzen. Ein Konzepttitel ist ein Begriff, keine Zusammenfassung. */
const MAX_TITLE = 120;
const MAX_SUMMARY = 600;

/**
 * Prueft und normalisiert eine Menge von Vorschlaegen.
 *
 * @param suggestions Rohvorschlaege des Modells.
 * @param knownSlugs Slugs bereits vorhandener Konzepte (Vorkapitel bzw.
 *   frueherer Teillauf). Treffer gelten als Dublette.
 */
export function normalizeSuggestions(
  suggestions: readonly ConceptSuggestion[],
  knownSlugs: ReadonlySet<string> = new Set(),
): NormalizeResult {
  const concepts: NormalizedConcept[] = [];
  const merged: NormalizeRejection[] = [];
  const rejected: NormalizeRejection[] = [];
  const seen = new Set(knownSlugs);

  for (const suggestion of suggestions) {
    const title = tidy(String(suggestion.titel ?? ''), MAX_TITLE);
    const summary = tidy(String(suggestion.kurzdefinition ?? ''), MAX_SUMMARY);

    if (title === '' || summary === '') {
      rejected.push({ title, reason: 'Titel oder Kurzdefinition fehlt.' });
      continue;
    }

    // Unbekannte Themenbereiche werden abgelehnt, nicht auf einen Default
    // umgebogen: Ein falsch einsortiertes Konzept verzerrt das Skill-Rating
    // in AP4 und faellt spaeter niemandem mehr auf.
    if (!isConceptTopicArea(suggestion.themenbereich)) {
      rejected.push({
        title,
        reason: `Unbekannter Themenbereich "${String(suggestion.themenbereich)}".`,
      });
      continue;
    }
    if (!isConceptLevel(suggestion.ab_level)) {
      rejected.push({ title, reason: `Unbekanntes Level "${String(suggestion.ab_level)}".` });
      continue;
    }

    const slug = conceptSlug(title);
    if (slug === '') {
      rejected.push({ title, reason: 'Titel ergibt keinen Schluessel.' });
      continue;
    }
    if (seen.has(slug)) {
      merged.push({ title, reason: `Dublette zu einem bereits bekannten Konzept (${slug}).` });
      continue;
    }
    seen.add(slug);

    concepts.push({
      slug,
      title,
      summary,
      topicArea: suggestion.themenbereich,
      minLevel: suggestion.ab_level,
      prerequisiteTitles: dedupeStrings(suggestion.voraussetzungen ?? []),
      sectionKeys: dedupeStrings(suggestion.sektionen ?? []),
    });
  }

  return { concepts, merged, rejected };
}

function dedupeStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
