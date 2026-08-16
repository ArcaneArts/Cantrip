CREATE TABLE "provider_quota_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"event_key" text NOT NULL,
	"observation_batch_key" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_account_label" text NOT NULL,
	"worker_id" text,
	"worker_name" text,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_percent_micros" integer NOT NULL,
	"resets_at" timestamp with time zone,
	"window_duration_minutes" integer,
	"limit_id" text,
	"limit_name" text,
	"window_kind" text NOT NULL,
	"plan_type" text,
	"reached_type" text,
	"observation_trigger" text NOT NULL,
	"is_weekly_projection" boolean DEFAULT false NOT NULL,
	"chat_id" text,
	"turn_id" text,
	"execution_attempt_id" text,
	"worker_version" text,
	"server_version" text,
	"codex_version" text,
	"sanitized_raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "provider_quota_observations_used_percent_check" CHECK ("provider_quota_observations"."used_percent_micros" BETWEEN 0 AND 100000000),
	CONSTRAINT "provider_quota_observations_window_duration_check" CHECK ("provider_quota_observations"."window_duration_minutes" IS NULL OR "provider_quota_observations"."window_duration_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_provider_account_workers" ADD COLUMN "weekly_usage_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "weekly_usage_observed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "model_provider_account_workers"
SET "weekly_usage_observed_at" = "last_synced_at"
WHERE "weekly_usage_used_basis_points" IS NOT NULL;--> statement-breakpoint
UPDATE "model_provider_accounts"
SET "weekly_usage_observed_at" = "auth_last_synced_at"
WHERE "weekly_usage_used_basis_points" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_quota_observations" ADD CONSTRAINT "provider_quota_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_quota_observations_owner_event_unique" ON "provider_quota_observations" USING btree ("owner_id","event_key");--> statement-breakpoint
CREATE INDEX "provider_quota_observations_account_time_index" ON "provider_quota_observations" USING btree ("provider_account_id","observed_at");--> statement-breakpoint
CREATE INDEX "provider_quota_observations_provider_time_index" ON "provider_quota_observations" USING btree ("provider_id","observed_at");--> statement-breakpoint
CREATE INDEX "provider_quota_observations_reset_window_index" ON "provider_quota_observations" USING btree ("provider_account_id","limit_id","window_kind","resets_at");--> statement-breakpoint
CREATE INDEX "provider_quota_observations_turn_index" ON "provider_quota_observations" USING btree ("chat_id","turn_id");--> statement-breakpoint
CREATE INDEX "provider_quota_observations_worker_time_index" ON "provider_quota_observations" USING btree ("worker_id","observed_at");
