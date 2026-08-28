import type {
  AdvanceBlocker,
  AdvanceDecision,
  AdvanceReason,
  LearningSignalClass,
  LearningThresholds,
} from '@gto/shared';

/**
 * Mastery-Score, Konfidenz und Weiterschalt-Entscheidung (AP4.T4.3).
 *
 * Ausschliesslich **reine Funktionen**. Keine Datenbank, keine Systemzeit, kein
 * Zufall - die Determinismus-Regel aus T4.2 gilt hier unveraendert, sonst waere
 * der Replay wertlos. Wo ein Zeitbezug noetig ist, kommt er entweder aus den
 * Ereigniszeitstempeln oder als ausdruecklicher `asOf`-Parameter herein.
 *
 * Dieses Modul ist **oeffentlich**, anders als `derive.ts`: AP5 muss
 * `evaluateAdvance` aufrufen koennen, um zu wissen, ob weitergeschaltet werden
 * darf. Es schreibt nichts und kann deshalb auch nichts umgehen.
 *
 * ## Wogegen das hier gebaut ist
 *
 * Risiko R3 aus dem Gesamtscope: Ein System, das sich selbst bewertet, ist zu
 * wohlwollend. Ein Sprachmodell, das eine freie Antwort beurteilt, sagt im
 * Zweifel "ja, im Wesentlichen richtig". Wer sich selbst einschaetzt, ueberschaetzt
 * sich. Beides zusammen ergaebe einen Lernstand, der gut aussieht und nichts
 * bedeutet.
 *
 * Die Gegenmassnahme hat drei Teile, und alle drei muessen zusammenwirken:
 * gewichtete Signale, eine getrennt gefuehrte Konfidenz und eine
 * Mindestanzahl objektiver Anker, an der kein hoher Score vorbeikommt.
 */

/* -------------------------------------------------------------------------
 * Die Konstanten - jede einzelne ist in ADR-0042 begruendet
 * ---------------------------------------------------------------------- */

/**
 * Wie weit ein Signal den Score bewegt.
 *
 * Objektive Treffer sind chart-verifizierbar oder eindeutig richtig - niemand
 * kann sie beschoenigen. KI-Bewertungen sind ein brauchbarer Hinweis, aber
 * anfaellig fuer Wohlwollen. Selbsteinschaetzungen zaehlen nur unterstuetzend.
 */
export const SCORE_WEIGHTS: Readonly<Record<LearningSignalClass, number>> = {
  objective: 1.0,
  ai_judged: 0.5,
  self_reported: 0.2,
};

/**
 * Wie sehr ein Signal die Aussage **festnagelt** - eine andere Frage als die
 * nach dem Score.
 *
 * Der Unterschied ist der Kern der Trennung von Score und Konfidenz: Eine
 * KI-Bewertung ist ein halbwegs brauchbarer Hinweis auf das Niveau (halbes
 * Score-Gewicht), aber ein schwacher **Beleg** dafuer, dass es wirklich sitzt.
 * Denn ihr Fehler ist **korreliert**: Ist das Modell zu freundlich, ist es bei
 * allen zehn Bewertungen zu freundlich. Zehn KI-Urteile sind deshalb nicht
 * zehnmal so aussagekraeftig wie eines - objektive Treffer dagegen schon.
 */
export const CONFIDENCE_WEIGHTS: Readonly<Record<LearningSignalClass, number>> = {
  objective: 1.0,
  ai_judged: 0.2,
  self_reported: 0.05,
};

/**
 * Gewicht des Vorwissens-Priors: So viel "Nichts weiss man" steht am Anfang in
 * der Waagschale.
 *
 * Ohne ihn haette ein einziger richtiger Treffer den Score 1,0 - "perfekt
 * beherrscht nach einer Frage". Mit Prior 0 und Gewicht 1 braucht es drei
 * saubere objektive Treffer fuer 0,75. Das ist die gewollte Traegheit.
 */
export const PRIOR_WEIGHT = 1.0;

/** Der Prior selbst: ohne Beleg gilt ein Konzept als nicht beherrscht. */
export const PRIOR_SCORE = 0;

/**
 * Halbwertszeit der zeitlichen Gewichtung in Tagen.
 *
 * Gemessen wird **nicht** gegen die Systemzeit, sondern gegen das juengste
 * Ereignis des Stroms. Nur so bleibt der Score allein aus dem Strom
 * reproduzierbar; sonst aenderte er sich, ohne dass etwas passiert waere.
 */
export const HALF_LIFE_DAYS = 30;

/**
 * Ab welchem Ergebnis ein Signal als misslungen gilt - dieselbe Schwelle wie
 * im Fehlerprotokoll aus T4.2.
 */
export const FAILURE_THRESHOLD = 0.5;

/**
 * Um wie viel ein Fehlschlag schwerer wiegt als ein Treffer.
 *
 * Begruendung: Die beiden sind nicht gleich aussagekraeftig. Bei einer Frage
 * mit vorgegebenen Antworten kann man raten und trifft; ein Treffer belegt also
 * nur "koennte koennen". Ein Fehler dagegen ist schwer zufaellig zu erzeugen -
 * er belegt eine Luecke. 1,5 ist bewusst moderat: Deutlich genug, dass ein
 * Fehler nicht in einer Serie von Treffern untergeht, aber nicht so hart, dass
 * ein einzelner Ausrutscher einen erarbeiteten Stand einreisst.
 */
export const FAILURE_WEIGHT_FACTOR = 1.5;

/**
 * Wie viel gewichtete Konfidenz-Evidenz noetig ist, damit die Konfidenz
 * spuerbar steigt. Bei diesem Wert liegt sie bei 1 - 1/e ≈ 0,63.
 */
export const CONFIDENCE_EVIDENCE_SCALE = 4;

/** Schwierigkeitsgewicht: leicht (0) zaehlt halb, schwer (1) anderthalbfach. */
export function difficultyFactor(difficulty: number): number {
  return 0.5 + clampRatio(difficulty);
}

/* -------------------------------------------------------------------------
 * Eingaben
 * ---------------------------------------------------------------------- */

/**
 * Ein Signal, wie die Mastery-Logik es sieht - die Ereignis-Mechanik aus T4.2
 * ist hier schon abgeraeumt (Korrekturen angewendet, Meta-Ereignisse raus).
 */
export interface MasterySignal {
  readonly signalClass: LearningSignalClass;
  /** Ergebnis 0 bis 1. */
  readonly outcome: number;
  /** Schwierigkeit 0 bis 1; kommt aus dem Ereignis, wird nie geraten. */
  readonly difficulty: number;
  /** Fachlicher Zeitpunkt des Ereignisses. */
  readonly occurredAt: Date;
}

/** Das Ergebnis der Berechnung - genau die Spalten von `concept_mastery`. */
export interface MasteryState {
  readonly score: number;
  readonly confidence: number;
  readonly objectiveSignals: number;
  readonly aiJudgedSignals: number;
  readonly selfReportedSignals: number;
  readonly lastCheckedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Haelt Rundungsreste innerhalb der CHECK-Constraints aus T4.1. */
function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Rundet einen gespeicherten Kennwert auf sechs Nachkommastellen.
 *
 * Kein Schoenheitsgriff, sondern eine Zusicherung: Gleitkomma-Addition ist
 * nicht assoziativ, eine andere Summationsreihenfolge liefert Abweichungen in
 * der letzten Stelle. Fuer den Score ist das bedeutungsloses Rauschen - fuer
 * den Replay-Vergleich aus T4.2 waere es ein Unterschied. Nach dem Runden ist
 * das Ergebnis von der Reihenfolge unabhaengig, und zwar nachweislich (Test
 * "liefert bei derselben Signalfolge zweimal identische Werte").
 */
function roundStored(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Zeitliche Gewichtung: exponentieller Abfall mit {@link HALF_LIFE_DAYS},
 * gemessen ab dem juengsten Ereignis des Stroms.
 *
 * Das juengste Ereignis hat damit immer Faktor 1. Ein Strom, zu dem nichts
 * hinzukommt, aendert seinen Score nicht - der Abfall ist **relativ**, nicht
 * absolut. Ohne diese Feinheit haenge der Score an der Uhr und der Replay
 * lieferte jedes Mal etwas anderes.
 */
export function recencyFactor(occurredAt: Date, newest: Date): number {
  const ageDays = Math.max(0, (newest.getTime() - occurredAt.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/* -------------------------------------------------------------------------
 * Score
 * ---------------------------------------------------------------------- */

/**
 * Mastery-Score aus einer Signalfolge - **reine Funktion**.
 *
 * Gewichteter Mittelwert mit Vorwissens-Prior:
 *
 * ```
 *            PRIOR_SCORE · PRIOR_WEIGHT + Σ wᵢ · outcomeᵢ
 *   score = ---------------------------------------------
 *                      PRIOR_WEIGHT + Σ wᵢ
 *
 *   wᵢ = Signalgewicht · Schwierigkeit · Aktualitaet · (Fehler? 1,5 : 1)
 * ```
 *
 * Der Prior ist der Grund, warum eine Serie freundlicher KI-Bewertungen nicht
 * dieselbe Wirkung hat wie eine Serie objektiver Treffer: Schwache Signale
 * ziehen den Score weniger weit vom Prior weg. Fuenf objektive Treffer ergeben
 * 5/6 ≈ 0,83, fuenf KI-Bewertungen mit demselben Ergebnis nur 2,5/3,5 ≈ 0,71 -
 * und das, obwohl beide Male alles "richtig" war.
 */
export function computeMasteryScore(signals: readonly MasterySignal[]): number {
  if (signals.length === 0) return clampRatio(PRIOR_SCORE);

  const newest = newestTimestamp(signals);
  let weighted = PRIOR_SCORE * PRIOR_WEIGHT;
  let total = PRIOR_WEIGHT;

  for (const signal of signals) {
    const weight = signalWeight(signal, newest);
    weighted += weight * clampRatio(signal.outcome);
    total += weight;
  }

  return roundStored(clampRatio(weighted / total));
}

/** Das Gewicht eines einzelnen Signals im Score. */
function signalWeight(signal: MasterySignal, newest: Date): number {
  const asymmetry = signal.outcome < FAILURE_THRESHOLD ? FAILURE_WEIGHT_FACTOR : 1;
  return (
    SCORE_WEIGHTS[signal.signalClass] *
    difficultyFactor(signal.difficulty) *
    recencyFactor(signal.occurredAt, newest) *
    asymmetry
  );
}

function newestTimestamp(signals: readonly MasterySignal[]): Date {
  return signals.reduce(
    (max, signal) => (signal.occurredAt.getTime() > max.getTime() ? signal.occurredAt : max),
    signals[0]?.occurredAt ?? new Date(0),
  );
}

/* -------------------------------------------------------------------------
 * Konfidenz
 * ---------------------------------------------------------------------- */

/**
 * Konfidenz aus einer Signalfolge - **getrennt vom Score, reine Funktion**.
 *
 * ```
 *   confidence = 1 − e^(−E / CONFIDENCE_EVIDENCE_SCALE)
 *   E = Σ Konfidenz-Gewicht(Klasse) · Aktualitaet
 * ```
 *
 * Sie beantwortet eine andere Frage als der Score: nicht "wie gut", sondern
 * "wie sicher wissen wir das". Deshalb eigene Gewichte
 * ({@link CONFIDENCE_WEIGHTS}) - und deshalb geht **weder** das Ergebnis noch
 * die Schwierigkeit ein: Auch ein Fehlschlag ist eine Messung und macht die
 * Einschaetzung sicherer, nicht unsicherer.
 *
 * Das Ergebnis ist der Wert **zum Zeitpunkt der letzten Pruefung**. Die
 * Veralterung seither kommt erst in {@link evaluateAdvance} dazu, weil sie von
 * "jetzt" abhaengt und "jetzt" in einer Ableitung nichts zu suchen hat.
 */
export function computeMasteryConfidence(signals: readonly MasterySignal[]): number {
  if (signals.length === 0) return 0;

  const newest = newestTimestamp(signals);
  let evidence = 0;
  for (const signal of signals) {
    evidence += CONFIDENCE_WEIGHTS[signal.signalClass] * recencyFactor(signal.occurredAt, newest);
  }

  return roundStored(clampRatio(1 - Math.exp(-evidence / CONFIDENCE_EVIDENCE_SCALE)));
}

/** Score, Konfidenz und Zaehler in einem Durchgang. */
export function computeMasteryState(signals: readonly MasterySignal[]): MasteryState | null {
  if (signals.length === 0) return null;

  let objective = 0;
  let aiJudged = 0;
  let selfReported = 0;
  for (const signal of signals) {
    if (signal.signalClass === 'objective') objective += 1;
    else if (signal.signalClass === 'ai_judged') aiJudged += 1;
    else selfReported += 1;
  }

  return {
    score: computeMasteryScore(signals),
    confidence: computeMasteryConfidence(signals),
    objectiveSignals: objective,
    aiJudgedSignals: aiJudged,
    selfReportedSignals: selfReported,
    lastCheckedAt: newestTimestamp(signals),
  };
}

/* -------------------------------------------------------------------------
 * Weiterschalt-Entscheidung
 * ---------------------------------------------------------------------- */

/** Alles, was die Entscheidung braucht - ausdruecklich hereingereicht. */
export interface AdvanceInput {
  /** Der gespeicherte Mastery-Stand. `null` = noch keine Belege. */
  readonly mastery: {
    readonly score: number;
    readonly confidence: number;
    readonly objectiveSignals: number;
    readonly aiJudgedSignals: number;
    readonly selfReportedSignals: number;
    readonly lastCheckedAt: Date | null;
  } | null;
  readonly thresholds: LearningThresholds;
  /**
   * Sind chart-verifizierbare Anker fuer dieses Konzept ueberhaupt moeglich?
   * Ermittelt aus `concept_chart` × `range_chart.state = 'approved'` - nicht
   * geraten und nicht fest verdrahtet (siehe `service.ts`).
   */
  readonly objectiveAnchorsPossible: boolean;
  /**
   * Bezugszeitpunkt fuer die Veralterung der Konfidenz.
   *
   * Ausdrueckliches Argument statt `new Date()`: So bleibt die Funktion rein
   * und pruefbar, und "jetzt" ist eine Entscheidung des Aufrufers - nicht ein
   * verstecktes Verhalten der Bewertungslogik.
   */
  readonly asOf: Date;
}

/**
 * Darf weitergegangen werden? - **reine Funktion mit strukturierter Begruendung**.
 *
 * Zwei Bedingungen, beide muessen erfuellt sein:
 *
 * 1. Der Score liegt **auf oder ueber** der Schwelle aus `learner_state`.
 * 2. Es liegen mindestens `minObjectiveAnchors` objektive Anker vor.
 *
 * **Bedingung 2 ist nicht verhandelbar.** Ein Score von 0,99 aus lauter
 * KI-Bewertungen schaltet nicht weiter - genau das ist der Punkt: Sonst
 * bestuende die Pruefung darin, dass ein Sprachmodell einem Sprachmodell
 * zustimmt.
 *
 * ### Uebergangszustand: keine Anker moeglich (Scope-Delta 2)
 *
 * Fuer die meisten Konzepte gibt es derzeit kein freigegebenes Chart - Stand
 * bei Abschluss von AP3: 16 von 168. Solche Konzepte duerfen nicht dauerhaft
 * unpassierbar sein, nur weil die Digitalisierung noch laeuft. Dann gilt
 * ersatzweise:
 *
 * - Score wie gehabt, **und**
 * - mindestens `minObjectiveAnchors` **Ersatzanker** - Signale, die nicht von
 *   einem Modell stammen (objektiv oder selbst eingeschaetzt).
 *
 * Der Ersatzanker ist die woertliche Umsetzung von "keine Weiterschaltung
 * allein auf KI-Bewertungen": Eine reine Serie von Modellurteilen kommt auch
 * hier nicht durch. Die Weiterschaltung wird als
 * `mastered_without_objective_anchors` gekennzeichnet, damit AP6 sie
 * ausweisen kann, und die Konfidenz bleibt von sich aus niedrig - ohne
 * objektive Signale traegt sie kaum Gewicht.
 *
 * **Das ist ausdruecklich ein Uebergang.** Sobald die Chart-Abdeckung steht,
 * greift fuer diese Konzepte wieder die volle Anforderung, ohne dass hier eine
 * Zeile geaendert werden muss - `objectiveAnchorsPossible` kippt von selbst.
 */
export function evaluateAdvance(input: AdvanceInput): AdvanceDecision {
  const { mastery, thresholds, objectiveAnchorsPossible, asOf } = input;

  const counts = {
    objective: mastery?.objectiveSignals ?? 0,
    aiJudged: mastery?.aiJudgedSignals ?? 0,
    selfReported: mastery?.selfReportedSignals ?? 0,
  };
  const substituteAnchors = counts.objective + counts.selfReported;
  const lastCheckedAt = mastery?.lastCheckedAt ?? null;
  const daysSinceLastCheck =
    lastCheckedAt === null
      ? null
      : Math.max(0, (asOf.getTime() - lastCheckedAt.getTime()) / DAY_MS);

  const storedConfidence = mastery?.confidence ?? 0;
  const confidence =
    daysSinceLastCheck === null
      ? 0
      : clampRatio(storedConfidence * Math.pow(0.5, daysSinceLastCheck / HALF_LIFE_DAYS));

  const base = {
    score: mastery?.score ?? 0,
    threshold: thresholds.masteryThreshold,
    storedConfidence,
    confidence,
    daysSinceLastCheck,
    objectiveAnchors: counts.objective,
    requiredObjectiveAnchors: thresholds.minObjectiveAnchors,
    objectiveAnchorsPossible,
    substituteAnchors,
    signalCounts: counts,
  };

  if (mastery === null) {
    return { ...base, allowed: false, reason: 'no_evidence', blockers: ['no_evidence'] };
  }

  const blockers: AdvanceBlocker[] = [];

  if (mastery.score < thresholds.masteryThreshold) {
    blockers.push('score_below_threshold');
  }

  if (objectiveAnchorsPossible) {
    if (counts.objective < thresholds.minObjectiveAnchors) {
      blockers.push('insufficient_objective_anchors');
    }
  } else if (substituteAnchors < thresholds.minObjectiveAnchors) {
    blockers.push('insufficient_substitute_anchors');
  }

  if (blockers.length > 0) {
    return { ...base, allowed: false, reason: primaryReason(blockers), blockers };
  }

  const reason: AdvanceReason = objectiveAnchorsPossible
    ? 'mastered'
    : 'mastered_without_objective_anchors';
  return { ...base, allowed: true, reason, blockers: [] };
}

/**
 * Der Grund, den die Anzeige zuerst nennt.
 *
 * Fehlende Anker stehen vor einem zu niedrigen Score: Sie sind die
 * ueberraschendere Auskunft. "Dein Score reicht, aber wir haben es nie
 * objektiv geprueft" muss der Nutzer als Erstes lesen - sonst haelt er die
 * Blockade fuer einen Fehler.
 */
function primaryReason(blockers: readonly AdvanceBlocker[]): AdvanceReason {
  if (blockers.includes('insufficient_objective_anchors')) return 'insufficient_objective_anchors';
  if (blockers.includes('insufficient_substitute_anchors')) {
    return 'insufficient_substitute_anchors';
  }
  if (blockers.includes('score_below_threshold')) return 'score_below_threshold';
  return 'no_evidence';
}
