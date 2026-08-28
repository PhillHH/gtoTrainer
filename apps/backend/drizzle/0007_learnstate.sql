CREATE TABLE "concept_mastery" (
	"concept_id" uuid PRIMARY KEY NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"objective_signals" integer DEFAULT 0 NOT NULL,
	"ai_judged_signals" integer DEFAULT 0 NOT NULL,
	"self_reported_signals" integer DEFAULT 0 NOT NULL,
	"last_event_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_mastery_score_check" CHECK ("concept_mastery"."score" >= 0 and "concept_mastery"."score" <= 1),
	CONSTRAINT "concept_mastery_confidence_check" CHECK ("concept_mastery"."confidence" >= 0 and "concept_mastery"."confidence" <= 1),
	CONSTRAINT "concept_mastery_counters_check" CHECK ("concept_mastery"."objective_signals" >= 0 and "concept_mastery"."ai_judged_signals" >= 0
          and "concept_mastery"."self_reported_signals" >= 0)
);
--> statement-breakpoint
CREATE TABLE "error_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context_kind" text NOT NULL,
	"context_ref" text,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"pattern_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_log_context_kind_check" CHECK (context_kind in ('theory_session', 'drill', 'hand_analysis', 'tournament', 'journal', 'manual')),
	CONSTRAINT "error_log_severity_check" CHECK (severity in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "learner_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"level" text DEFAULT 'einsteiger' NOT NULL,
	"current_chapter" integer DEFAULT 1 NOT NULL,
	"current_concept_id" uuid,
	"mastery_threshold" double precision DEFAULT 0.8 NOT NULL,
	"min_objective_anchors" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_state_singleton_check" CHECK ("learner_state"."singleton"),
	CONSTRAINT "learner_state_level_check" CHECK (level in ('einsteiger', 'fortgeschritten', 'experte')),
	CONSTRAINT "learner_state_chapter_check" CHECK ("learner_state"."current_chapter" >= 1),
	CONSTRAINT "learner_state_threshold_check" CHECK ("learner_state"."mastery_threshold" >= 0 and "learner_state"."mastery_threshold" <= 1),
	CONSTRAINT "learner_state_anchors_check" CHECK ("learner_state"."min_objective_anchors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "learning_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"signal_class" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concept_id" uuid NOT NULL,
	"chart_id" uuid,
	"corrects_event_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_event_type_check" CHECK (event_type in ('question_answered', 'concept_explained', 'drill_completed', 'hand_analyzed', 'review_performed', 'manual_correction')),
	CONSTRAINT "learning_event_source_check" CHECK (source in ('theory_session', 'drill', 'hand_analysis', 'tournament', 'journal', 'manual')),
	CONSTRAINT "learning_event_signal_class_check" CHECK (signal_class in ('objective', 'ai_judged', 'self_reported')),
	CONSTRAINT "learning_event_correction_check" CHECK ((event_type = 'manual_correction') = (corrects_event_id is not null)),
	CONSTRAINT "learning_event_no_self_correction_check" CHECK ("learning_event"."corrects_event_id" <> "learning_event"."id")
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"concept_id" uuid PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"ease_factor" double precision DEFAULT 2.5 NOT NULL,
	"repetitions" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_queue_origin_check" CHECK (origin in ('error', 'knowledge_gap', 'practice_finding')),
	CONSTRAINT "review_queue_interval_check" CHECK ("review_queue"."interval_days" >= 0),
	CONSTRAINT "review_queue_ease_check" CHECK ("review_queue"."ease_factor" >= 1.3 and "review_queue"."ease_factor" <= 3.0),
	CONSTRAINT "review_queue_counters_check" CHECK ("review_queue"."repetitions" >= 0 and "review_queue"."lapses" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_rating" (
	"topic_area" text PRIMARY KEY NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_rating_topic_area_check" CHECK (topic_area in ('grundlagen-mathematik', 'spieltheorie', 'software-werkzeuge', 'preflop-ranges', 'preflop-verteidigung', 'spiel-gegen-3bets', 'turnier-metriken-icm', 'postflop-grundlagen', 'flop-spiel', 'turn-spiel', 'river-spiel', 'mental-game')),
	CONSTRAINT "skill_rating_value_check" CHECK ("skill_rating"."rating" >= 0 and "skill_rating"."rating" <= 1),
	CONSTRAINT "skill_rating_event_count_check" CHECK ("skill_rating"."event_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_rating_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_area" text NOT NULL,
	"rating" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_rating_snapshot_value_check" CHECK ("skill_rating_snapshot"."rating" >= 0 and "skill_rating_snapshot"."rating" <= 1)
);
--> statement-breakpoint
ALTER TABLE "concept_mastery" ADD CONSTRAINT "concept_mastery_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mastery" ADD CONSTRAINT "concept_mastery_last_event_id_learning_event_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."learning_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_log" ADD CONSTRAINT "error_log_event_id_learning_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."learning_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_log" ADD CONSTRAINT "error_log_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_state" ADD CONSTRAINT "learner_state_current_concept_id_concept_id_fk" FOREIGN KEY ("current_concept_id") REFERENCES "public"."concept"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_event" ADD CONSTRAINT "learning_event_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_event" ADD CONSTRAINT "learning_event_chart_id_range_chart_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."range_chart"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_event" ADD CONSTRAINT "learning_event_corrects_event_id_learning_event_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."learning_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_rating_snapshot" ADD CONSTRAINT "skill_rating_snapshot_topic_area_skill_rating_topic_area_fk" FOREIGN KEY ("topic_area") REFERENCES "public"."skill_rating"("topic_area") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_mastery_score_idx" ON "concept_mastery" USING btree ("score");--> statement-breakpoint
CREATE INDEX "error_log_concept_idx" ON "error_log" USING btree ("concept_id","occurred_at");--> statement-breakpoint
CREATE INDEX "error_log_occurred_at_idx" ON "error_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "error_log_event_idx" ON "error_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "error_log_pattern_idx" ON "error_log" USING btree ("pattern_tag");--> statement-breakpoint
CREATE UNIQUE INDEX "learner_state_singleton_key" ON "learner_state" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "learning_event_concept_idx" ON "learning_event" USING btree ("concept_id","occurred_at");--> statement-breakpoint
CREATE INDEX "learning_event_occurred_at_idx" ON "learning_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "learning_event_source_idx" ON "learning_event" USING btree ("source");--> statement-breakpoint
CREATE INDEX "learning_event_corrects_idx" ON "learning_event" USING btree ("corrects_event_id");--> statement-breakpoint
CREATE INDEX "review_queue_due_idx" ON "review_queue" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "review_queue_origin_idx" ON "review_queue" USING btree ("origin","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_rating_snapshot_key" ON "skill_rating_snapshot" USING btree ("topic_area","captured_at");