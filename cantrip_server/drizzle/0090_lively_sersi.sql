CREATE TABLE "model_behavior_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"source_key" text NOT NULL,
	"project_id" text,
	"chat_id" text,
	"model_id" text,
	"model_route_id" text,
	"provider_id" text,
	"model_name" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_model_name" text NOT NULL,
	"provider_account_id" text,
	"worker_id" text,
	"turn_id" text,
	"execution_attempt_id" text NOT NULL,
	"attempt_kind" text DEFAULT 'chat-turn' NOT NULL,
	"attempt_status" text DEFAULT 'running' NOT NULL,
	"reasoning_effort" text,
	"route_attempt_index" integer DEFAULT 0 NOT NULL,
	"retry_failover_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_activity_at" timestamp with time zone,
	"first_visible_response_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"duration_ms" bigint,
	"final_answer_appeared" boolean DEFAULT false NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"invalid_tool_call_count" integer DEFAULT 0 NOT NULL,
	"compaction_count" integer DEFAULT 0 NOT NULL,
	"approval_request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_output_tokens" bigint DEFAULT 0 NOT NULL,
	"model_context_window" bigint,
	"context_used_percent_basis_points" integer,
	"files_changed_count" integer DEFAULT 0 NOT NULL,
	"test_command_count" integer DEFAULT 0 NOT NULL,
	"test_pass_count" integer DEFAULT 0 NOT NULL,
	"test_failure_count" integer DEFAULT 0 NOT NULL,
	"user_interrupted" boolean DEFAULT false NOT NULL,
	"user_retry_regeneration" boolean,
	"immediate_corrective_followup" boolean DEFAULT false NOT NULL,
	"fork_count" integer DEFAULT 0 NOT NULL,
	"copy_count" integer,
	"rating_value" integer,
	"worker_version" text,
	"server_version" text,
	"codex_version" text,
	"signal_availability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_behavior_observations_status_check" CHECK ("model_behavior_observations"."attempt_status" IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "model_behavior_observations_nonnegative_check" CHECK ("model_behavior_observations"."route_attempt_index" >= 0 AND "model_behavior_observations"."retry_failover_count" >= 0 AND "model_behavior_observations"."tool_call_count" >= 0 AND "model_behavior_observations"."invalid_tool_call_count" >= 0 AND "model_behavior_observations"."compaction_count" >= 0 AND "model_behavior_observations"."approval_request_count" >= 0 AND "model_behavior_observations"."input_tokens" >= 0 AND "model_behavior_observations"."cached_input_tokens" >= 0 AND "model_behavior_observations"."cache_write_input_tokens" >= 0 AND "model_behavior_observations"."output_tokens" >= 0 AND "model_behavior_observations"."reasoning_output_tokens" >= 0 AND "model_behavior_observations"."files_changed_count" >= 0 AND "model_behavior_observations"."test_command_count" >= 0 AND "model_behavior_observations"."test_pass_count" >= 0 AND "model_behavior_observations"."test_failure_count" >= 0 AND "model_behavior_observations"."fork_count" >= 0),
	CONSTRAINT "model_behavior_observations_context_percent_check" CHECK ("model_behavior_observations"."context_used_percent_basis_points" IS NULL OR "model_behavior_observations"."context_used_percent_basis_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_model_catalog_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_account_id" text,
	"worker_id" text,
	"availability_scope" text NOT NULL,
	"native_model_id" text NOT NULL,
	"canonical_model_id" text,
	"metadata_source" text NOT NULL,
	"metadata_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_behavior_observations" ADD CONSTRAINT "model_behavior_observations_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_catalog_snapshots" ADD CONSTRAINT "provider_model_catalog_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_behavior_observations_owner_source_unique" ON "model_behavior_observations" USING btree ("owner_id","source_key");--> statement-breakpoint
CREATE INDEX "model_behavior_observations_account_time_index" ON "model_behavior_observations" USING btree ("owner_id","provider_account_id","started_at");--> statement-breakpoint
CREATE INDEX "model_behavior_observations_model_time_index" ON "model_behavior_observations" USING btree ("owner_id","model_id","started_at");--> statement-breakpoint
CREATE INDEX "model_behavior_observations_project_time_index" ON "model_behavior_observations" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "model_behavior_observations_turn_index" ON "model_behavior_observations" USING btree ("chat_id","turn_id");--> statement-breakpoint
CREATE INDEX "model_behavior_observations_attempt_index" ON "model_behavior_observations" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_catalog_snapshots_version_unique" ON "provider_model_catalog_snapshots" USING btree ("owner_id","provider_id","availability_scope","native_model_id","metadata_hash");--> statement-breakpoint
CREATE INDEX "provider_model_catalog_snapshots_model_time_index" ON "provider_model_catalog_snapshots" USING btree ("owner_id","provider_id","native_model_id","observed_at");--> statement-breakpoint
CREATE INDEX "provider_model_catalog_snapshots_hash_index" ON "provider_model_catalog_snapshots" USING btree ("metadata_hash");