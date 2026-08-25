/**
 * Verträge rund um die Buch-Wissensbasis (AP3.T3.1).
 *
 * Backend (Ingestion, Content-API) und Frontend (Review-Ansichten ab T3.4)
 * teilen sich diese Typen. Die Klassifikation entscheidet in T3.3 darüber,
 * welche Bilder überhaupt durch die Vision-Pipeline laufen - deshalb liegt
 * sie hier als Vertrag und nicht als Backend-Interna.
 */

/**
 * Assettypen eines Buchbildes.
 *
 * - `hand_range` - 13x13-Range-Chart. **Nur diese** gehen in T3.3 an Vision.
 * - `table`      - tabellarische Abbildung (Frequenzen, Stacktiefen, EV).
 * - `diagram`    - Schaubild, Baum, Heatmap, Verteilungsgrafik.
 * - `formula`    - gesetzte Formel als Bild (im Fließtext eingebettet).
 * - `other`      - alles Übrige (Cover, Autorenfoto, Unklares).
 */
export const BOOK_ASSET_TYPES = ['hand_range', 'table', 'diagram', 'formula', 'other'] as const;

export type BookAssetType = (typeof BOOK_ASSET_TYPES)[number];

export function isBookAssetType(value: unknown): value is BookAssetType {
  return typeof value === 'string' && (BOOK_ASSET_TYPES as readonly string[]).includes(value);
}

/**
 * Sicherheit der Klassifikation.
 *
 * `uncertain` heißt: die Regel hat geraten bzw. gar nichts gefunden. Solche
 * Assets erscheinen im Import-Report und werden in T3.3 bewusst behandelt,
 * statt still mitzulaufen.
 */
export const BOOK_ASSET_CONFIDENCES = ['certain', 'uncertain'] as const;

export type BookAssetConfidence = (typeof BOOK_ASSET_CONFIDENCES)[number];

export function isBookAssetConfidence(value: unknown): value is BookAssetConfidence {
  return typeof value === 'string' && (BOOK_ASSET_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Ein aus der Bildunterschrift gelesener Aktions-Prozentwert.
 *
 * Diese Werte sind in T3.4 die **unabhängige Gegenprobe** zur Vision-
 * Extraktion. Sie werden deshalb unverändert übernommen: `percent` ist exakt
 * die Zahl aus der Unterschrift, nicht gerundet und nicht normalisiert.
 */
export interface BookCaptionAction {
  /** Aktionsname wie in der Unterschrift, z. B. `All-in`, `Raise 3.3x`, `Fold`. */
  readonly action: string;
  /** Prozentwert aus der Unterschrift, z. B. `23.7`. */
  readonly percent: number;
}

/** Strukturierte Bestandteile einer Bildunterschrift. */
export interface BookCaption {
  /** Rohtext der Unterschrift, zeilenweise verbunden - verlustfrei. */
  readonly raw: string;
  /** Erkanntes Etikett, z. B. `Hand Range`, `Table`, `Diagram`, `Heatmap`. */
  readonly label: string | null;
  /** Erkannte Nummer, z. B. 96 aus `Hand Range 96:`. */
  readonly number: number | null;
  /** Spot-Beschreibung, z. B. `SB vs BB (15bb)`. */
  readonly spot: string | null;
  /** Aktions-Prozentwerte; leer, wenn keine erkannt wurden. */
  readonly actions: readonly BookCaptionAction[];
}
