import { loadConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { enqueueJob } from './queue.js';
import { LLM_COMPLETE_JOB } from './handlers/llm-complete.js';

/**
 * Plant einen Job von der Kommandozeile ein (AP2.T2.5).
 *
 * Betriebswerkzeug: Damit laesst sich ein Aufruf anstossen, ohne dass es dafuer
 * schon eine Oberflaeche gibt. Ab AP3 planen die Fach-Module ihre Jobs selbst
 * ueber `enqueueJob()` ein.
 *
 *   pnpm jobs:enqueue task/concept-explanation '{"level":"Einsteiger", …}'
 *   pnpm jobs:enqueue --type eigener.typ '{"…":"…"}'
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Ohne --type ist der Referenz-Job gemeint; dann sind die Argumente
  // Template-Kennung und Platzhalterwerte. Mit --type folgt die rohe Nutzlast.
  let jobType = LLM_COMPLETE_JOB;
  let rawPayload = false;
  if (args[0] === '--type') {
    jobType = args[1] ?? '';
    rawPayload = true;
    args.splice(0, 2);
  }

  const [first, second] = args;
  if (first === undefined) {
    throw new Error(
      'Aufruf: pnpm jobs:enqueue <template-id> \'{"platzhalter":"wert"}\'\n' +
        "        pnpm jobs:enqueue --type <job-typ> '<payload-json>'",
    );
  }

  const payload = rawPayload
    ? parseJson(first)
    : { templateId: first, values: parseJson(second ?? '{}') };

  const config = loadConfig();
  const handle = createDb(config.databaseUrl, { max: 1 });
  try {
    const job = await enqueueJob(handle.db, { jobType, payload });
    console.warn(`Job eingeplant: ${job.id} (${job.jobType}, ${job.status})`);
  } finally {
    await handle.close();
  }
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('kein Objekt');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Die Nutzlast ist kein gueltiges JSON-Objekt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
