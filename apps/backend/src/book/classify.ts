import type { BookAssetConfidence, BookAssetType, BookCaption } from '@gto/shared';

/**
 * Regelbasierte Asset-Klassifikation (AP3.T3.1, Scope-Delta 2 aus AP03.md).
 *
 * **Ohne KI-Aufruf.** Die Klassifikation ist ein Filterschritt vor der
 * Vision-Pipeline und darf kein Kontingent verbrauchen; außerdem muss sie
 * reproduzierbar sein. Grundlage sind ausschließlich Bildunterschrift und das
 * unmittelbare Umfeld im Text.
 *
 * Die Regeln werden **in dieser Reihenfolge** geprüft; die erste passende
 * gewinnt. Ihr Name landet in `book_asset.classification_rule`, damit im
 * Nachhinein nachvollziehbar ist, warum ein Asset seinen Typ hat.
 *
 * | Regel                   | Bedingung                                              | Typ          | Sicherheit  |
 * | ----------------------- | ------------------------------------------------------ | ------------ | ----------- |
 * | `caption-label`         | Unterschrift trägt ein bekanntes Etikett               | s. Zuordnung | `certain`   |
 * | `caption-actions`       | keine Etikett-Zuordnung, aber Aktions-Prozente         | `hand_range` | `uncertain` |
 * | `front-matter`          | Asset liegt vor dem ersten Kapitel                     | `other`      | `certain`   |
 * | `formula-lead-in`       | ohne Unterschrift, Absatz davor endet auf `:`          | `formula`    | `certain`   |
 * | `formula-where`         | ohne Unterschrift, Absatz danach beginnt mit `where`   | `formula`    | `certain`   |
 * | `caption-without-label` | Unterschrift ohne erkennbare Struktur                  | `other`      | `uncertain` |
 * | `unclassified`          | nichts davon trifft zu                                 | `other`      | `uncertain` |
 *
 * Etikett-Zuordnung: `Hand Range` → `hand_range`; `Table` → `table`;
 * `Diagram`, `Heatmap`, `Figure`, `Chart` → `diagram`.
 */

/** Zuordnung Unterschrift-Etikett → Assettyp. */
const LABEL_TO_TYPE: Readonly<Record<string, BookAssetType>> = {
  'hand range': 'hand_range',
  table: 'table',
  diagram: 'diagram',
  heatmap: 'diagram',
  figure: 'diagram',
  chart: 'diagram',
};

/** Alle Regelnamen - auch für die Auswertung im Report. */
export const CLASSIFICATION_RULES = [
  'caption-label',
  'caption-actions',
  'front-matter',
  'formula-lead-in',
  'formula-where',
  'caption-without-label',
  'unclassified',
] as const;

export type ClassificationRule = (typeof CLASSIFICATION_RULES)[number];

export interface ClassificationInput {
  /** Zerlegte Unterschrift, `null` wenn das Bild keine trägt. */
  readonly caption: BookCaption | null;
  /** Letzter Textabsatz vor dem Bild (ohne Seitenmarker und Bildzeilen). */
  readonly textBefore: string;
  /** Erster Textabsatz nach dem Bild. */
  readonly textAfter: string;
  /** Liegt das Bild vor dem ersten Kapitel (Cover, Impressum, Inhalt)? */
  readonly isFrontMatter: boolean;
}

export interface Classification {
  readonly type: BookAssetType;
  readonly confidence: BookAssetConfidence;
  readonly rule: ClassificationRule;
}

/** Wendet die Regeltabelle an. Erste passende Regel gewinnt. */
export function classifyAsset(input: ClassificationInput): Classification {
  const { caption, textBefore, textAfter, isFrontMatter } = input;

  if (caption?.label) {
    const type = LABEL_TO_TYPE[caption.label.toLowerCase()];
    if (type) return { type, confidence: 'certain', rule: 'caption-label' };
  }

  if (caption && caption.actions.length > 0) {
    return { type: 'hand_range', confidence: 'uncertain', rule: 'caption-actions' };
  }

  if (isFrontMatter) {
    return { type: 'other', confidence: 'certain', rule: 'front-matter' };
  }

  if (!caption) {
    // Formelbilder stehen im Buch als Fortsetzung eines Satzes, der mit einem
    // Doppelpunkt endet ("… the number of combinations is:"), oder werden
    // direkt danach mit "where …" erläutert.
    if (/:\s*$/.test(textBefore)) {
      return { type: 'formula', confidence: 'certain', rule: 'formula-lead-in' };
    }
    if (/^where\b/i.test(textAfter.trim())) {
      return { type: 'formula', confidence: 'certain', rule: 'formula-where' };
    }
    return { type: 'other', confidence: 'uncertain', rule: 'unclassified' };
  }

  return { type: 'other', confidence: 'uncertain', rule: 'caption-without-label' };
}
