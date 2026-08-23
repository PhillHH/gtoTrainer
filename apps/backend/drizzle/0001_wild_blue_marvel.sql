ALTER TABLE "session" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
DROP INDEX "session_token_key";--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");