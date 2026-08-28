import { createDb } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { redact } from '../db/migrate.js';
import { countLearningRows } from './seed.js';
import { replayLearningState } from './service.js';

/**
 * CLI-Einstieg: `pnpm learning:replay`.
 *
 * Rechnet den abgeleiteten Lernstand aus dem Ereignisstrom neu. Braucht keine
 * Bestaetigung: Der Replay verwirft nichts, was sich nicht aus den Ereignissen
 * wiederherstellen liesse - die Ereignisse selbst bleiben unangetastet.
 */
export async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    console.error(`[learning:replay] Rechne den Lernstand in ${redact(databaseUrl)} neu ...`);
    const before = await countLearningRows(handle.db);
    const result = await replayLearningState(handle.db);
    const after = await countLearningRows(handle.db);
    console.error(
      `[learning:replay] ${result.events} Ereignisse ueber ${result.concepts} Konzepte ` +
        `und ${result.topicAreas} Themenbereiche verarbeitet.`,
    );
    console.error(
      `[learning:replay] concept_mastery ${before.conceptMastery} -> ${after.conceptMastery}, ` +
        `review_queue ${before.reviewQueue} -> ${after.reviewQueue}, ` +
        `error_log ${before.errorLog} -> ${after.errorLog}.`,
    );
  } finally {
    await handle.close();
  }
}
