import { createDb } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { redact } from '../db/migrate.js';
import { readLearningThresholds, updateLearningThresholds } from './service.js';
import type { LearningThresholdUpdate } from '@gto/shared';

/**
 * CLI-Einstieg: `pnpm learning:thresholds [--score <0.5-0.95>] [--anchors <0-10>]`.
 *
 * Ohne Argumente zeigt es nur den Stand. Die Grenzen prueft der Service, nicht
 * dieses Skript - es gibt genau eine Stelle, an der entschieden wird.
 */
export function parseArgs(argv: readonly string[]): LearningThresholdUpdate {
  const patch: { masteryThreshold?: number; minObjectiveAnchors?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--score' || flag === '--anchors') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error(`${flag} braucht einen Wert.`);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`${flag}: "${raw}" ist keine Zahl.`);
      if (flag === '--score') patch.masteryThreshold = value;
      else patch.minObjectiveAnchors = value;
      i += 1;
    } else {
      throw new Error(`Unbekanntes Argument "${String(flag)}". Erlaubt: --score, --anchors.`);
    }
  }
  return patch;
}

export async function main(): Promise<void> {
  const patch = parseArgs(process.argv.slice(2));
  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const before = await readLearningThresholds(handle.db);
    console.error(
      `[learning:thresholds] ${redact(databaseUrl)} - aktuell: Schwelle ${before.masteryThreshold}, ` +
        `objektive Anker ${before.minObjectiveAnchors}`,
    );
    if (Object.keys(patch).length === 0) return;

    const after = await updateLearningThresholds(handle.db, patch);
    console.error(
      `[learning:thresholds] neu: Schwelle ${after.masteryThreshold}, ` +
        `objektive Anker ${after.minObjectiveAnchors}`,
    );
  } finally {
    await handle.close();
  }
}
