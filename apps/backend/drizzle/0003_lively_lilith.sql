CREATE TABLE "concept" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"topic_area" text NOT NULL,
	"min_level" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"origin" text DEFAULT 'ai' NOT NULL,
	"ordinal" integer NOT NULL,
	"unresolved_prerequisites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_topic_area_check" CHECK (topic_area in ('grundlagen-mathematik', 'spieltheorie', 'software-werkzeuge', 'preflop-ranges', 'preflop-verteidigung', 'spiel-gegen-3bets', 'turnier-metriken-icm', 'postflop-grundlagen', 'flop-spiel', 'turn-spiel', 'river-spiel', 'mental-game')),
	CONSTRAINT "concept_min_level_check" CHECK (min_level in ('einsteiger', 'fortgeschritten', 'experte')),
	CONSTRAINT "concept_state_check" CHECK (state in ('draft', 'approved')),
	CONSTRAINT "concept_origin_check" CHECK (origin in ('ai', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "concept_chart" (
	"concept_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source" text DEFAULT 'section' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_chart_concept_id_asset_id_pk" PRIMARY KEY("concept_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "concept_prerequisite" (
	"concept_id" uuid NOT NULL,
	"prerequisite_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_prerequisite_concept_id_prerequisite_id_pk" PRIMARY KEY("concept_id","prerequisite_id"),
	CONSTRAINT "concept_prerequisite_no_self_check" CHECK ("concept_prerequisite"."concept_id" <> "concept_prerequisite"."prerequisite_id")
);
--> statement-breakpoint
CREATE TABLE "concept_section" (
	"concept_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_section_concept_id_section_id_pk" PRIMARY KEY("concept_id","section_id")
);
--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_chapter_id_book_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."book_chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_chart" ADD CONSTRAINT "concept_chart_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_chart" ADD CONSTRAINT "concept_chart_asset_id_book_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."book_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_prerequisite" ADD CONSTRAINT "concept_prerequisite_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_prerequisite" ADD CONSTRAINT "concept_prerequisite_prerequisite_id_concept_id_fk" FOREIGN KEY ("prerequisite_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_section" ADD CONSTRAINT "concept_section_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_section" ADD CONSTRAINT "concept_section_section_id_book_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."book_section"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concept_slug_key" ON "concept" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "concept_chapter_idx" ON "concept" USING btree ("chapter_id","ordinal");--> statement-breakpoint
CREATE INDEX "concept_topic_area_idx" ON "concept" USING btree ("topic_area");--> statement-breakpoint
CREATE INDEX "concept_state_idx" ON "concept" USING btree ("state");--> statement-breakpoint
CREATE INDEX "concept_chart_asset_idx" ON "concept_chart" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "concept_prerequisite_prereq_idx" ON "concept_prerequisite" USING btree ("prerequisite_id");--> statement-breakpoint
CREATE INDEX "concept_section_section_idx" ON "concept_section" USING btree ("section_id");