ALTER TABLE "token_usage_records" DROP CONSTRAINT "token_usage_records_nonnegative_check";--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "execution_attempt_id" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "attempt_kind" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "attempt_status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "worker_version" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "server_version" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "codex_version" text;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "cache_write_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "visible_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "reported_total_tokens" bigint;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "usage_semantics" text DEFAULT 'provider-reported-v2' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "sanitized_raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "token_usage_records"
SET
	"attempt_kind" = 'legacy-aggregate',
	"usage_semantics" = 'legacy-derived-v1',
	"started_at" = "created_at",
	"completed_at" = "updated_at",
	"finalized_at" = "updated_at";--> statement-breakpoint
CREATE INDEX "token_usage_records_owner_account_time_index" ON "token_usage_records" USING btree ("owner_id","provider_account_id","started_at");--> statement-breakpoint
CREATE INDEX "token_usage_records_worker_time_index" ON "token_usage_records" USING btree ("worker_id","started_at");--> statement-breakpoint
CREATE INDEX "token_usage_records_execution_attempt_index" ON "token_usage_records" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE INDEX "token_usage_records_turn_index" ON "token_usage_records" USING btree ("chat_id","turn_id");--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_nonnegative_check" CHECK ("token_usage_records"."input_tokens" >= 0 AND "token_usage_records"."output_tokens" >= 0 AND "token_usage_records"."cached_input_tokens" >= 0 AND "token_usage_records"."reasoning_output_tokens" >= 0 AND "token_usage_records"."cache_write_input_tokens" >= 0 AND ("token_usage_records"."visible_output_tokens" IS NULL OR "token_usage_records"."visible_output_tokens" >= 0) AND ("token_usage_records"."reported_total_tokens" IS NULL OR "token_usage_records"."reported_total_tokens" >= 0));
