ALTER TABLE "range_chart" ADD COLUMN "legend_totals" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "range_chart" ADD COLUMN "legend_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "range_chart" ADD COLUMN "legend_labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Die vierte Pruefung (AP3.T3.6-fix) bringt eine neue Pruefart mit. Der CHECK
-- wird aus `CHART_CHECKS` in `packages/shared` gebildet; drizzle-kit erkennt
-- eine Aenderung daran nicht, deshalb steht sie hier von Hand.
ALTER TABLE "chart_finding" DROP CONSTRAINT IF EXISTS "chart_finding_check_check";--> statement-breakpoint
ALTER TABLE "chart_finding" ADD CONSTRAINT "chart_finding_check_check"
  CHECK ("check" in ('frequency-sum', 'caption-match', 'legend-match', 'plausibility'));
