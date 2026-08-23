import { prepareTestDatabase } from './setup.js';

/**
 * Vitest-globalSetup: bereitet die Testdatenbank EINMAL pro Testlauf vor
 * (anlegen, Schema verwerfen, migrieren). Damit teilen sich alle Testdateien
 * einen definierten Ausgangszustand, ohne sich gegenseitig das Schema
 * wegzuziehen.
 */
export default async function setup(): Promise<void> {
  await prepareTestDatabase();
}
