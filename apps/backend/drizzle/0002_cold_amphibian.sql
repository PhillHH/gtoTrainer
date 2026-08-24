CREATE TABLE "book_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relative_path" text NOT NULL,
	"file_name" text NOT NULL,
	"section_id" uuid,
	"page" integer,
	"index_on_page" integer,
	"caption_raw" text,
	"caption_label" text,
	"caption_number" integer,
	"caption_spot" text,
	"caption_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_type" text NOT NULL,
	"classification_confidence" text NOT NULL,
	"classification_rule" text NOT NULL,
	"file_present" boolean DEFAULT true NOT NULL,
	"ordinal" integer NOT NULL,
	"content_hash" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_asset_type_check" CHECK (asset_type in ('hand_range', 'table', 'diagram', 'formula', 'other')),
	CONSTRAINT "book_asset_confidence_check" CHECK (classification_confidence in ('certain', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "book_chapter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_number" integer NOT NULL,
	"part_title" text NOT NULL,
	"chapter_number" integer NOT NULL,
	"title" text NOT NULL,
	"ordinal" integer NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"content_hash" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"title" text NOT NULL,
	"level" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"body" text NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"content_hash" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_asset" ADD CONSTRAINT "book_asset_section_id_book_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."book_section"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_section" ADD CONSTRAINT "book_section_chapter_id_book_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."book_chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_asset_path_key" ON "book_asset" USING btree ("relative_path");--> statement-breakpoint
CREATE INDEX "book_asset_type_idx" ON "book_asset" USING btree ("asset_type","ordinal");--> statement-breakpoint
CREATE INDEX "book_asset_section_idx" ON "book_asset" USING btree ("section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "book_chapter_number_key" ON "book_chapter" USING btree ("chapter_number");--> statement-breakpoint
CREATE INDEX "book_chapter_part_idx" ON "book_chapter" USING btree ("part_number","chapter_number");--> statement-breakpoint
CREATE UNIQUE INDEX "book_section_key_key" ON "book_section" USING btree ("section_key");--> statement-breakpoint
CREATE INDEX "book_section_chapter_idx" ON "book_section" USING btree ("chapter_id","ordinal");