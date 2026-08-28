-- AP4.T4.6 - Muster-Report und Muster-Zuordnung (ADR-0046).
--
-- `pattern_report` haelt jeden erzeugten Report samt Zeitraum, Modell und den
-- aggregierten Kennzahlen, aus denen er entstand. Aeltere Reports bleiben
-- stehen: Dass dasselbe Muster seit sechs Wochen drinsteht, ist selbst eine
-- Auskunft.
--
-- `error_pattern_tag` ordnet ein erkanntes Muster einem einzelnen
-- Fehler-Ereignis zu. Warum das eine eigene Tabelle ist und nicht einfach in
-- `error_log.pattern_tag` steht: `error_log` ist eine Projektion des
-- Ereignisstroms und wird bei jedem neuen Ereignis des Konzepts neu aufgebaut
-- (T4.2). Ein direkt hineingeschriebener Tag waere beim naechsten
-- Schreibvorgang weg - und nach einem Replay ohnehin. Der Tag ist eine
-- Annotation am Ereignis, keine Ableitung daraus; `error_log.pattern_tag`
-- wird beim Projizieren von hier befuellt.

CREATE TABLE "error_pattern_tag" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pattern_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"model" text,
	"provider" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"concept_count" integer DEFAULT 0 NOT NULL,
	"patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aggregate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"input_digest" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pattern_report_status_check" CHECK (status in ('complete', 'insufficient_data'))
);
--> statement-breakpoint
ALTER TABLE "error_pattern_tag" ADD CONSTRAINT "error_pattern_tag_event_id_learning_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."learning_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_pattern_tag" ADD CONSTRAINT "error_pattern_tag_report_id_pattern_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."pattern_report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_pattern_tag_report_idx" ON "error_pattern_tag" USING btree ("report_id","tag");--> statement-breakpoint
CREATE INDEX "pattern_report_generated_idx" ON "pattern_report" USING btree ("generated_at");