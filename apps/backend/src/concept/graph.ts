/**
 * Zyklenpruefung des Prerequisite-Graphen (AP3.T3.2, Subtask 5).
 *
 * **Deterministisch, ohne KI.** Ein Zyklus ("A setzt B voraus, B setzt A
 * voraus") macht jeden Lernpfad unableitbar: AP5 kaeme bei der Frage "was
 * zuerst?" nie zu einem Ergebnis. Das Schema kann die Zyklenfreiheit nicht
 * erzwingen - sie ist eine Eigenschaft des ganzen Graphen -, also wird sie
 * geprueft und gemeldet.
 */

/** Gerichtete Kante: `prerequisiteId` muss vor `conceptId` verstanden sein. */
export interface PrerequisiteEdge {
  readonly conceptId: string;
  readonly prerequisiteId: string;
}

/**
 * Sucht alle Zyklen in einem gerichteten Graphen.
 *
 * Tiefensuche mit Farbmarkierung: Eine Kante zurueck auf einen Knoten, der im
 * aktuellen Pfad liegt (grau), schliesst einen Zyklus. Der zurueckgegebene Pfad
 * beginnt und endet beim selben Knoten, damit er sich in der Review-Ansicht
 * lesbar darstellen laesst.
 *
 * Es werden **alle** gefundenen Zyklen gemeldet, nicht nur der erste: Wer einen
 * auflaest, will nicht beim naechsten Lauf den zweiten entdecken.
 */
export function findCycles(edges: readonly PrerequisiteEdge[]): string[][] {
  // Nachfolger: von der Voraussetzung zum abhaengigen Konzept. Diese Richtung
  // entspricht der Lernreihenfolge.
  const next = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.conceptId);
    nodes.add(edge.prerequisiteId);
    const list = next.get(edge.prerequisiteId) ?? [];
    list.push(edge.conceptId);
    next.set(edge.prerequisiteId, list);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const node of nodes) colour.set(node, WHITE);

  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): void => {
    colour.set(node, GREY);
    path.push(node);

    for (const successor of next.get(node) ?? []) {
      const state = colour.get(successor) ?? WHITE;
      if (state === GREY) {
        const start = path.indexOf(successor);
        const cycle = [...path.slice(start), successor];
        // Derselbe Zyklus kann ueber verschiedene Startknoten gefunden werden;
        // ein rotationsunabhaengiger Schluessel meldet ihn nur einmal.
        const key = canonicalKey(cycle.slice(0, -1));
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      if (state === WHITE) visit(successor);
    }

    path.pop();
    colour.set(node, BLACK);
  };

  // Sortiert starten, damit das Ergebnis bei gleicher Eingabe gleich bleibt.
  for (const node of [...nodes].sort()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }

  return cycles;
}

/** Rotationsunabhaengige Kennung eines Zyklus. */
function canonicalKey(cycle: readonly string[]): string {
  if (cycle.length === 0) return '';
  let smallest = 0;
  for (let i = 1; i < cycle.length; i++) {
    if ((cycle[i] as string) < (cycle[smallest] as string)) smallest = i;
  }
  return [...cycle.slice(smallest), ...cycle.slice(0, smallest)].join('>');
}

/** Kurzform: Gibt es ueberhaupt einen Zyklus? */
export function hasCycle(edges: readonly PrerequisiteEdge[]): boolean {
  return findCycles(edges).length > 0;
}

/**
 * Waehlt aus einer Kantenliste die Kanten aus, die **ohne** Zyklus bleiben.
 *
 * Wird beim Persistieren genutzt: Eine Kante, die einen Zyklus schliessen
 * wuerde, wird nicht gespeichert, sondern als offener Punkt gemeldet. So bleibt
 * die Datenbank jederzeit zyklenfrei, und der Konflikt geht trotzdem nicht
 * verloren.
 */
export function selectAcyclicEdges(edges: readonly PrerequisiteEdge[]): {
  accepted: PrerequisiteEdge[];
  rejected: PrerequisiteEdge[];
} {
  const accepted: PrerequisiteEdge[] = [];
  const rejected: PrerequisiteEdge[] = [];

  for (const edge of edges) {
    if (edge.conceptId === edge.prerequisiteId) {
      rejected.push(edge);
      continue;
    }
    if (hasCycle([...accepted, edge])) {
      rejected.push(edge);
      continue;
    }
    accepted.push(edge);
  }

  return { accepted, rejected };
}
