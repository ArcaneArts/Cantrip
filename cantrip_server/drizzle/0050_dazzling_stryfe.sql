CREATE TABLE "token_usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text,
	"chat_id" text,
	"source_key" text NOT NULL,
	"model_id" text,
	"model_route_id" text,
	"provider_id" text,
	"model_name" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_model_name" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_usage_records_nonnegative_check" CHECK ("token_usage_records"."input_tokens" >= 0 AND "token_usage_records"."output_tokens" >= 0 AND "token_usage_records"."cached_input_tokens" >= 0 AND "token_usage_records"."reasoning_output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_records" ADD CONSTRAINT "token_usage_records_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_usage_records_owner_source_unique" ON "token_usage_records" USING btree ("owner_id","source_key");--> statement-breakpoint
CREATE INDEX "token_usage_records_project_created_index" ON "token_usage_records" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "token_usage_records_owner_provider_index" ON "token_usage_records" USING btree ("owner_id","provider_id");--> statement-breakpoint
CREATE INDEX "token_usage_records_owner_model_index" ON "token_usage_records" USING btree ("owner_id","model_id");