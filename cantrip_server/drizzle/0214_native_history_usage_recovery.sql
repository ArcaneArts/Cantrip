ALTER TABLE "token_usage_records" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "native_history_turns" ADD COLUMN "usage" jsonb;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "native_usage" jsonb;