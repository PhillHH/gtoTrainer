CREATE TABLE "range_chart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"state" text DEFAULT 'raw' NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uncertain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cell_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"duration_ms" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "range_chart_state_check" CHECK (state in ('raw', 'validated', 'approved', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "range_chart_cell" (
	"chart_id" uuid NOT NULL,
	"hand" text NOT NULL,
	"action_kind" text NOT NULL,
	"sizing" text DEFAULT '' NOT NULL,
	"percent" double precision NOT NULL,
	CONSTRAINT "range_chart_cell_chart_id_hand_action_kind_sizing_pk" PRIMARY KEY("chart_id","hand","action_kind","sizing"),
	CONSTRAINT "range_chart_cell_kind_check" CHECK (action_kind in ('fold', 'check', 'call', 'limp', 'bet', 'raise', 'three_bet', 'four_bet', 'five_bet', 'all_in')),
	CONSTRAINT "range_chart_cell_percent_check" CHECK ("range_chart_cell"."percent" >= 0 and "range_chart_cell"."percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "range_chart" ADD CONSTRAINT "range_chart_asset_id_book_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."book_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "range_chart_cell" ADD CONSTRAINT "range_chart_cell_chart_id_range_chart_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."range_chart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "range_chart_asset_key" ON "range_chart" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "range_chart_state_idx" ON "range_chart" USING btree ("state");--> statement-breakpoint
CREATE INDEX "range_chart_run_idx" ON "range_chart" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "range_chart_cell_hand_idx" ON "range_chart_cell" USING btree ("hand","action_kind");