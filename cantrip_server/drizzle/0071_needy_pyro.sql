CREATE TABLE "model_provider_account_workers" (
	"account_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"auth_state" text DEFAULT 'unknown' NOT NULL,
	"weekly_usage_used_basis_points" integer,
	"weekly_usage_resets_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_account_workers_account_id_worker_id_pk" PRIMARY KEY("account_id","worker_id"),
	CONSTRAINT "model_provider_account_workers_auth_state_check" CHECK ("model_provider_account_workers"."auth_state" IN ('unknown', 'signed-out', 'signed-in', 'failed')),
	CONSTRAINT "model_provider_account_workers_usage_check" CHECK ("model_provider_account_workers"."weekly_usage_used_basis_points" IS NULL OR "model_provider_account_workers"."weekly_usage_used_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "model_provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"email" text,
	"plan_type" text,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_home_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_catalog_sync_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"worker_id" text,
	"provider_account_id" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"error" text,
	"etag" text,
	"refresh_started_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_catalog_sync_states_status_check" CHECK ("provider_catalog_sync_states"."status" IN ('idle', 'refreshing', 'current', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "provider_model_availability" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_model_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"worker_id" text,
	"provider_account_id" text,
	"state" text DEFAULT 'available' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_model_availability_state_check" CHECK ("provider_model_availability"."state" IN ('available', 'unavailable', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "provider_model_suppressions" (
	"owner_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_model_suppressions_owner_id_provider_model_id_pk" PRIMARY KEY("owner_id","provider_model_id")
);
--> statement-breakpoint
CREATE TABLE "provider_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"native_model_id" text NOT NULL,
	"canonical_model_id" text,
	"display_name" text NOT NULL,
	"description" text,
	"context_window" integer,
	"max_output_tokens" integer,
	"input_modalities" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"output_modalities" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"supports_tools" boolean,
	"supports_parallel_tools" boolean,
	"supports_structured_output" boolean,
	"supports_vision" boolean,
	"supports_reasoning" boolean,
	"supported_reasoning_efforts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_reasoning_effort" text,
	"reasoning_mandatory" boolean,
	"family" text,
	"parameter_size" text,
	"quantization" text,
	"digest" text,
	"metadata_source" text NOT NULL,
	"match_confidence_basis_points" integer,
	"hidden" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_models_metadata_source_check" CHECK ("provider_models"."metadata_source" IN ('ollama', 'openrouter', 'codex', 'compatible-api', 'manual')),
	CONSTRAINT "provider_models_context_window_check" CHECK ("provider_models"."context_window" IS NULL OR "provider_models"."context_window" > 0),
	CONSTRAINT "provider_models_max_output_tokens_check" CHECK ("provider_models"."max_output_tokens" IS NULL OR "provider_models"."max_output_tokens" > 0),
	CONSTRAINT "provider_models_match_confidence_check" CHECK ("provider_models"."match_confidence_basis_points" IS NULL OR "provider_models"."match_confidence_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "canonical_model_id" text;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "discovery_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "weekly_usage_reserve_percent" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_routes" ADD COLUMN "provider_model_id" text;--> statement-breakpoint
ALTER TABLE "model_routes" ADD COLUMN "discovery_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_account_workers" ADD CONSTRAINT "model_provider_account_workers_account_id_model_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."model_provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_account_workers" ADD CONSTRAINT "model_provider_account_workers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_catalog_sync_states" ADD CONSTRAINT "provider_catalog_sync_states_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_catalog_sync_states" ADD CONSTRAINT "provider_catalog_sync_states_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_catalog_sync_states" ADD CONSTRAINT "provider_catalog_sync_states_provider_account_id_model_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."model_provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_availability" ADD CONSTRAINT "provider_model_availability_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_availability" ADD CONSTRAINT "provider_model_availability_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_availability" ADD CONSTRAINT "provider_model_availability_provider_account_id_model_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."model_provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_suppressions" ADD CONSTRAINT "provider_model_suppressions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_suppressions" ADD CONSTRAINT "provider_model_suppressions_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_provider_account_workers_worker_index" ON "model_provider_account_workers" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_accounts_provider_position_unique" ON "model_provider_accounts" USING btree ("provider_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_accounts_provider_home_unique" ON "model_provider_accounts" USING btree ("provider_id","credential_home_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_catalog_sync_states_provider_scope_unique" ON "provider_catalog_sync_states" USING btree ("provider_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_availability_model_scope_unique" ON "provider_model_availability" USING btree ("provider_model_id","scope_key");--> statement-breakpoint
CREATE INDEX "provider_model_availability_worker_index" ON "provider_model_availability" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "provider_model_availability_account_index" ON "provider_model_availability" USING btree ("provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_models_provider_native_unique" ON "provider_models" USING btree ("provider_id","native_model_id");--> statement-breakpoint
CREATE INDEX "provider_models_canonical_index" ON "provider_models" USING btree ("canonical_model_id");--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_weekly_usage_reserve_percent_check" CHECK ("model_providers"."weekly_usage_reserve_percent" BETWEEN 0 AND 100);