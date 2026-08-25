import { conceptSlug } from './normalize.js';

/**
 * Aufloesung von Titel-Referenzen auf echte IDs (AP3.T3.2, Subtask 5).
 *
 * **Deterministisch, ohne KI.** Das Modell kennt keine Datenbankschluessel und
 * nennt Voraussetzungen als Titel. Hier werden sie ueber denselben Slug
 * gefunden, den auch die Dubletten-Erkennung nutzt - damit sind
 * "Minimum Defense Frequency (MDF)" und "minimum defense frequency" derselbe
 * Verweis.
 *
 * Was sich nicht aufloesen laesst, wird **nicht stillschweigend verworfen**:
 * Es landet als offener Punkt am Konzept und ist in der Review-Ansicht
 * sichtbar.
 */

export interface ResolveResult {
  /** Aufgeloeste Voraussetzungen als Konzept-IDs, ohne Dubletten. */
  readonly ids: readonly string[];
  /** Titel, zu denen kein Konzept gefunden wurde. */
  readonly unresolved: readonly string[];
}

/**
 * Loest Titel-Referenzen gegen ein Verzeichnis `slug -> id` auf.
 *
 * @param selfId ID des Konzepts, dessen Voraussetzungen aufgeloest werden.
 *   Ein Selbstverweis wird verworfen - er waere ein Zyklus der Laenge 1 und
 *   verstiesse gegen den CHECK auf `concept_prerequisite`.
 */
export function resolvePrerequisiteTitles(
  titles: readonly string[],
  bySlug: ReadonlyMap<string, string>,
  selfId?: string,
): ResolveResult {
  const ids: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const title of titles) {
    const slug = conceptSlug(title);
    const id = slug === '' ? undefined : bySlug.get(slug);

    if (id === undefined) {
      if (!unresolved.includes(title)) unresolved.push(title);
      continue;
    }
    if (id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return { ids, unresolved };
}

/**
 * Loest Sektionsschluessel auf.
 *
 * Das Modell bekommt die Schluessel woertlich im Prompt und soll sie
 * zurueckgeben. Toleriert wird trotzdem ein Verweis ohne Kapitelpraefix
 * (`small-blind-pfi-strategy` statt `ch07/small-blind-pfi-strategy`), solange
 * er innerhalb der angebotenen Sektionen eindeutig ist.
 */
export function resolveSectionKeys(
  keys: readonly string[],
  byKey: ReadonlyMap<string, string>,
): ResolveResult {
  const ids: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  // Kurzform -> Schluessel, nur wo eindeutig.
  const bySuffix = new Map<string, string | null>();
  for (const key of byKey.keys()) {
    const suffix = key.slice(key.indexOf('/') + 1);
    bySuffix.set(suffix, bySuffix.has(suffix) ? null : key);
  }

  for (const raw of keys) {
    const key = raw.trim();
    let id = byKey.get(key);
    if (id === undefined) {
      const full = bySuffix.get(key);
      if (full) id = byKey.get(full);
    }

    if (id === undefined) {
      if (!unresolved.includes(key)) unresolved.push(key);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return { ids, unresolved };
}
