import { sql } from 'drizzle-orm';
import type { Database } from '../../src/db/client.js';
import { bookChapter, concept } from '../../src/db/schema.js';

/**
 * Hilfen fuer die Lernstand-Tests (AP4.T4.1).
 *
 * Datenbank echt, nichts gemockt - geprueft werden Constraints und Trigger,
 * und die gibt es nur in Postgres. **Kein KI-Aufruf** in diesem Bereich.
 */

/** Leert die Lernstand-Tabellen und die Konzept-/Buchgeruest-Fixtures. */
export async function clearLearning(db: Database): Promise<void> {
  // TRUNCATE umgeht den Append-only-Trigger auf `learning_event` - genau
  // deshalb ist es der einzige Weg, das Protokoll ueberhaupt zu leeren
  // (siehe src/learning/reset.ts).
  await db.execute(
    sql`truncate table skill_rating_snapshot, skill_rating, error_log, review_queue,
        concept_mastery, learning_event, learner_state, concept, book_chapter cascade`,
  );
}

export interface LearningFixture {
  /** Konzept im Zustand `approved`. */
  readonly approvedConceptId: string;
  /** Konzept im Zustand `draft` - Scope-Delta 3. */
  readonly draftConceptId: string;
}

/**
 * Legt ein Kapitel und zwei Konzepte an: eines bestaetigt, eines im Entwurf.
 * Der Entwurf ist der Fall aus Scope-Delta 3 - der Lernstand muss auch auf ihm
 * gefuehrt werden koennen.
 */
export async function seedConcepts(db: Database): Promise<LearningFixture> {
  const [chapter] = await db
    .insert(bookChapter)
    .values({
      partNumber: 1,
      partTitle: 'Testteil',
      chapterNumber: 1,
      title: 'Erstes Kapitel',
      ordinal: 0,
      contentHash: 'hash-ap4-chapter-1',
    })
    .returning({ id: bookChapter.id });
  const chapterId = (chapter as { id: string }).id;

  const rows = await db
    .insert(concept)
    .values([
      {
        chapterId,
        slug: 'ap4-bestaetigtes-konzept',
        title: 'Bestaetigtes Konzept',
        summary: 'Fixture-Definition, kein Buchinhalt.',
        topicArea: 'grundlagen-mathematik',
        minLevel: 'einsteiger',
        state: 'approved',
        origin: 'manual',
        ordinal: 0,
      },
      {
        chapterId,
        slug: 'ap4-entwurfs-konzept',
        title: 'Entwurfs-Konzept',
        summary: 'Fixture-Definition, kein Buchinhalt.',
        topicArea: 'flop-spiel',
        minLevel: 'einsteiger',
        state: 'draft',
        origin: 'ai',
        ordinal: 1,
      },
    ])
    .returning({ id: concept.id, state: concept.state });

  const approved = rows.find((row) => row.state === 'approved');
  const draft = rows.find((row) => row.state === 'draft');
  if (!approved || !draft) throw new Error('Fixture unvollstaendig.');

  return { approvedConceptId: approved.id, draftConceptId: draft.id };
}

/** Minimales, gueltiges Ereignis. Felder lassen sich gezielt ueberschreiben. */
export function anEvent(
  conceptId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    eventType: 'question_answered',
    source: 'theory_session',
    signalClass: 'objective',
    conceptId,
    payload: {},
    ...overrides,
  };
}

/**
 * Fuehrt etwas aus, das an der Datenbank scheitern MUSS, und liefert die
 * Meldung von Postgres zurueck.
 *
 * Drizzle verpackt den pg-Fehler: Die eigene Meldung nennt nur die Abfrage,
 * die Ursache mit Constraint-Name steht in `cause`. Ohne das Auspacken wuerde
 * ein Test auch dann bestehen, wenn ein *anderes* Constraint gegriffen hat.
 */
export async function failing(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('Der Vorgang haette scheitern muessen.');
}

/**
 * Liest den kompletten abgeleiteten Zustand als Vergleichswert.
 *
 * Bewusst mit allen Spalten und in fester Reihenfolge: Der Replay-Test
 * vergleicht Zeile fuer Zeile, nicht nur Zeilenzahlen. Ein Zeitstempel, der
 * aus der Systemzeit statt aus dem Ereignis stammt, faellt genau hier auf.
 */
export async function derivedState(db: Database): Promise<Record<string, unknown[]>> {
  const read = async (query: string): Promise<unknown[]> =>
    (await db.execute<Record<string, unknown>>(sql.raw(query))).rows;

  return {
    conceptMastery: await read('select * from concept_mastery order by concept_id'),
    reviewQueue: await read('select * from review_queue order by concept_id'),
    errorLog: await read('select * from error_log order by id'),
    skillRating: await read('select * from skill_rating order by topic_area'),
    skillRatingSnapshot: await read('select * from skill_rating_snapshot order by id'),
  };
}
