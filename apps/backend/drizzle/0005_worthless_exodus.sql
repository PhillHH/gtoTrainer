CREATE TABLE "chart_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chart_id" uuid NOT NULL,
	"check" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"hand" text,
	"action_kind" text,
	"measured" double precision,
	"expected" double precision,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_finding_check_check" CHECK ("check" in ('frequency-sum', 'caption-match', 'plausibility')),
	CONSTRAINT "chart_finding_severity_check" CHECK (severity in ('error', 'warning', 'info'))
);
--> statement-breakpoint
CREATE TABLE "chart_recheck" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chart_id" uuid NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"flagged_hands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cells_compared" integer DEFAULT 0 NOT NULL,
	"cells_agreed" integer DEFAULT 0 NOT NULL,
	"cells_changed" integer DEFAULT 0 NOT NULL,
	"cells_protected" integer DEFAULT 0 NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "range_chart" DROP CONSTRAINT "range_chart_state_check";--> statement-breakpoint
ALTER TABLE "range_chart" ADD COLUMN "unusable_reason" text;--> statement-breakpoint
ALTER TABLE "range_chart" ADD COLUMN "validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "range_chart" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "range_chart_cell" ADD COLUMN "source" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "range_chart_cell" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chart_finding" ADD CONSTRAINT "chart_finding_chart_id_range_chart_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."range_chart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_recheck" ADD CONSTRAINT "chart_recheck_chart_id_range_chart_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."range_chart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_finding_chart_idx" ON "chart_finding" USING btree ("chart_id");--> statement-breakpoint
CREATE INDEX "chart_finding_check_idx" ON "chart_finding" USING btree ("check","severity");--> statement-breakpoint
CREATE INDEX "chart_recheck_chart_idx" ON "chart_recheck" USING btree ("chart_id");--> statement-breakpoint
ALTER TABLE "range_chart" ADD CONSTRAINT "range_chart_state_check" CHECK (state in ('raw', 'validated', 'approved', 'failed', 'unusable'));--> statement-breakpoint
ALTER TABLE "range_chart_cell" ADD CONSTRAINT "range_chart_cell_source_check" CHECK (source in ('model', 'manual'));