import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { findRepoRoot, loadConfig, loadLlmConfig } from '../config/env.js';
import { createDb } from '../db/client.js';
import { bookAsset } from '../db/schema.js';
import { createDbCallLogSink } from '../llm/call-log.js';
import { LlmProviderRegistry } from '../llm/registry.js';
import { createSettingsReader } from '../llm/settings.js';
import { TemplateRegistry } from '../prompts/registry.js';
import { formatScores, scoreModel } from './calibrate.js';
import type { ChartAttempt, ReferenceChart } from './calibrate.js';
import { captionActionsToLegend, parseChartSpot, toChartMatrix } from './spot.js';
import { readChartImage } from './store.js';
import {
  readExtraction,
  renderActions,
  renderHandList,
  renderSpot,
} from '../jobs/handlers/chart-digitize.js';

/**
 * Kalibrierungslauf vor dem Massenlauf (AP3.T3.3, Scope-Delta 3).
 *
 *   pnpm charts:calibrate --model claude-haiku-4-5 --model claude-sonnet-5
 *
 * Digitalisiert die Stichprobe aus
 * `test/chart/fixtures/calibration-reference.json` mit **jedem** angegebenen
 * Modell und haelt die Ergebnisse gegen die von Hand geprueften Sollwerte.
 *
 * Der Lauf schreibt **nicht** in `range_chart`: Er dient der Modellwahl, nicht
 * dem Aufbau der Wissensbasis. Die Antworten landen als JSON unter
 * `data/reports/chart-calibration/` (git-ignoriert); die Messwerte gehen ins
 * Terminal und in denselben Ordner.
 *
 * Die Aufrufe laufen ueber die Provider-Registry - Protokoll und
 * Fehler-Taxonomie greifen wie ueberall. Bewusst **ohne** Job-Queue: Die Queue
 * traegt den Massenlauf; hier sind es acht Aufrufe je Modell, die nacheinander
 * und sichtbar laufen sollen.
 */

const REFERENCE_PATH = fileURLToPath(
  new URL('../../test/chart/fixtures/calibration-reference.json', import.meta.url),
);

interface Args {
  models: string[];
  out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { models: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--model') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '')
        throw new Error('--model erwartet einen Wert.');
      args.models.push(value.trim());
    } else if (flag === '--out') {
      args.out = argv[++i];
    } else {
      throw new Error(
        `Unbekanntes Argument: ${String(flag)}\n` +
          'Aufruf: pnpm charts:calibrate --model <id> [--model <id> …] [--out <verzeichnis>]',
      );
    }
  }
  if (args.models.length < 2) {
    throw new Error(
      'Mindestens zwei Modelle angeben - der Sinn der Kalibrierung ist der Vergleich ' +
        '(AP03.md, Scope-Delta 3).',
    );
  }
  return args;
}

function loadReference(): ReferenceChart[] {
  const raw = JSON.parse(readFileSync(REFERENCE_PATH, 'utf8')) as { charts: ReferenceChart[] };
  return raw.charts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const references = loadReference();
  const config = loadConfig();
  const llmConfig = loadLlmConfig();
  const handle = createDb(config.databaseUrl, { max: 2 });

  const outDir = args.out ?? join(findRepoRoot(), 'data', 'reports', 'chart-calibration');
  mkdirSync(outDir, { recursive: true });

  try {
    const templates = TemplateRegistry.load();
    const settings = createSettingsReader(handle.db, llmConfig);
    const providers = new LlmProviderRegistry({
      config: llmConfig,
      settings,
      callLog: { sink: createDbCallLogSink(handle.db) },
    });
    // Der Provider (cli/api) bleibt der eingestellte; kalibriert wird das
    // Modell, nicht der Transportweg.
    const providerId = (await settings.read()).provider;

    console.warn(`Stichprobe: ${references.length} Charts, Modelle: ${args.models.join(', ')}`);
    console.warn('');

    const results = [];

    for (const model of args.models) {
      const attempts: ChartAttempt[] = [];

      for (const reference of references) {
        const [asset] = await handle.db
          .select()
          .from(bookAsset)
          .where(and(eq(bookAsset.fileName, reference.file), isNull(bookAsset.removedAt)));

        if (!asset) {
          console.warn(`  ${model} / HR ${reference.handRange}: Asset ${reference.file} fehlt.`);
          continue;
        }

        const captionActions = Array.isArray(asset.captionActions)
          ? (asset.captionActions as { action: string; percent: number }[])
          : [];
        const spot = parseChartSpot(asset.captionSpot, captionActions);
        const legend = captionActionsToLegend(captionActions);
        const image = readChartImage(asset.relativePath);

        const request = templates.renderRequest(
          'task/chart-digitize',
          {
            unterschrift: asset.captionRaw ?? '(keine Unterschrift im Buch)',
            spot: renderSpot(spot),
            aktionen: renderActions(legend.actions),
            blattliste: renderHandList(),
          },
          {
            model,
            maxTokens: 16384,
            images: [{ type: 'image', mediaType: image.mediaType, data: image.data }],
          },
        );

        // Wiederaufnahme: Eine bereits aufgezeichnete Antwort wird gelesen
        // statt neu abgefragt. Der Kalibrierungslauf ist damit genauso
        // fortsetzbar wie der Massenlauf - ein abgebrochener Lauf kostet nicht
        // das Kontingent der schon erledigten Charts.
        const recordedPath = join(outDir, `${model}--hr${reference.handRange}.json`);
        if (existsSync(recordedPath)) {
          const recorded = JSON.parse(readFileSync(recordedPath, 'utf8')) as {
            zellen: unknown;
            unsicher?: string[];
            durationMs?: number;
            totalTokens?: number | null;
            error?: string;
          };
          const matrix = toChartMatrix(recorded.zellen);
          attempts.push({
            handRange: reference.handRange,
            matrix,
            durationMs: recorded.durationMs ?? 0,
            totalTokens: recorded.totalTokens ?? null,
            uncertain: recorded.unsicher ?? [],
            ...(recorded.error === undefined ? {} : { error: recorded.error }),
          });
          console.warn(
            `  ${model} / HR ${reference.handRange}: ${matrix.length} Zellen (aufgezeichnet)`,
          );
          continue;
        }

        const startedAt = Date.now();
        try {
          const provider = providers.get(providerId, { model });
          const response = await provider.complete(request);
          const parsed = readExtraction(response.json ?? response.text);
          const matrix = toChartMatrix(parsed.zellen);

          attempts.push({
            handRange: reference.handRange,
            matrix,
            durationMs: response.meta.durationMs,
            totalTokens: response.meta.totalTokens,
            uncertain: parsed.unsicher,
          });

          writeFileSync(
            recordedPath,
            `${JSON.stringify(
              {
                model,
                handRange: reference.handRange,
                zellen: parsed.zellen,
                unsicher: parsed.unsicher,
                legende: parsed.legende,
                durationMs: response.meta.durationMs,
                totalTokens: response.meta.totalTokens,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );

          console.warn(
            `  ${model} / HR ${reference.handRange}: ${matrix.length} Zellen, ` +
              `${Math.round(response.meta.durationMs / 1000)} s, ` +
              `${response.meta.totalTokens ?? '?'} Tokens`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          attempts.push({
            handRange: reference.handRange,
            matrix: [],
            durationMs: Date.now() - startedAt,
            totalTokens: null,
            uncertain: [],
            error: message.slice(0, 200),
          });
          // Auch ein Fehlschlag wird aufgezeichnet - er ist ein Messwert.
          writeFileSync(
            recordedPath,
            `${JSON.stringify(
              {
                model,
                handRange: reference.handRange,
                zellen: [],
                unsicher: [],
                legende: [],
                durationMs: Date.now() - startedAt,
                totalTokens: null,
                error: message.slice(0, 200),
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
          console.warn(`  ${model} / HR ${reference.handRange}: FEHLER - ${message.slice(0, 120)}`);
        }
      }

      results.push(scoreModel(model, references, attempts));
    }

    console.warn('');
    console.warn(formatScores(results));

    const reportPath = join(outDir, 'ergebnis.md');
    writeFileSync(
      reportPath,
      [
        '# Kalibrierungslauf Chart-Digitalisierung (AP3.T3.3)',
        '',
        `- Erzeugt: ${new Date().toISOString()}`,
        `- Stichprobe: ${references.length} Charts`,
        '',
        formatScores(results),
        '',
        '## Je Chart',
        '',
        '| Modell | HR | Zellen | Referenzzellen | Ø Caption-Abw. | Dauer | Tokens |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...results.flatMap((result) =>
          result.scores.map(
            (score) =>
              `| \`${result.model}\` | ${score.handRange} | ${score.cellCount} | ` +
              `${score.cellsCorrect}/${score.cellsChecked} | ` +
              `${score.captionDeviationPp === null ? '—' : `${score.captionDeviationPp.toFixed(1)} pp`} | ` +
              `${Math.round(score.durationMs / 1000)} s | ${score.totalTokens ?? '—'} |`,
          ),
        ),
        '',
      ].join('\n'),
      'utf8',
    );

    console.warn('');
    console.warn(`Bericht: ${reportPath}`);
    console.warn(`Rohantworten: ${dirname(reportPath)}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[charts:calibrate] Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
