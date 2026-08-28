import { randomUUID } from 'node:crypto';
import { LEARNER_LEVELS, MANUAL_LEVEL_GRACE_DAYS, isLearnerLevel } from '@gto/shared';
import { createDb } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { redact } from '../db/migrate.js';
import { readLearnerLevel, setLearnerLevel } from './service.js';

/**
 * CLI-Einstieg: `pnpm learning:level [<stufe>] [--reason "..."]`.
 *
 * Ohne Argument zeigt es nur den Stand samt Kennzahlen. Mit Stufe setzt es das
 * Level **als Ereignis** - nicht als Schreibzugriff, damit der Replay davon
 * weiss (ADR-0045).
 */
export function parseArgs(argv: readonly string[]): { level?: string; reason?: string } {
  const result: { level?: string; reason?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--reason') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--reason braucht einen Text.');
      result.reason = value;
      i += 1;
    } else if (typeof token === 'string' && !token.startsWith('--')) {
      result.level = token;
    } else {
      throw new Error(`Unbekanntes Argument "${String(token)}". Erlaubt: <stufe>, --reason.`);
    }
  }
  return result;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.level !== undefined && !isLearnerLevel(args.level)) {
    throw new Error(`Unbekannte Stufe "${args.level}". Erlaubt: ${LEARNER_LEVELS.join(', ')}.`);
  }

  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const before = await readLearnerLevel(handle.db);
    console.error(
      `[learning:level] ${redact(databaseUrl)} - aktuell: ${before.level} (${before.source})` +
        (before.manualUntil ? `, manuell bis ${before.manualUntil}` : ''),
    );
    console.error(
      `[learning:level] Kennzahlen: Rating-Schnitt ${before.signals.averageRating.toFixed(3)}, ` +
        `Themenbereiche mit Daten ${before.signals.coveredTopicAreas}, ` +
        `belastbare Konzepte ${before.signals.masteredConcepts}, ` +
        `objektiver Anteil ${(before.signals.objectiveShare * 100).toFixed(1)} % ` +
        `-> Automatik saehe ${before.automaticLevel}`,
    );

    if (args.level === undefined) return;

    await setLearnerLevel(handle.db, {
      eventId: randomUUID(),
      level: args.level,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    });
    const after = await readLearnerLevel(handle.db);
    console.error(
      `[learning:level] gesetzt auf ${after.level}; gilt ${MANUAL_LEVEL_GRACE_DAYS} Tage, ` +
        `dann greift die Automatik wieder.`,
    );
  } finally {
    await handle.close();
  }
}
