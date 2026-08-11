CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environment_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bearer_token_environment_variable" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" IN ('stdio', 'http')),
	CONSTRAINT "mcp_servers_transport_configuration_check" CHECK (("mcp_servers"."transport" = 'stdio' AND "mcp_servers"."command" IS NOT NULL AND "mcp_servers"."url" IS NULL) OR ("mcp_servers"."transport" = 'http' AND "mcp_servers"."command" IS NULL AND "mcp_servers"."url" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_global_name_unique" ON "mcp_servers" USING btree ("owner_id","name") WHERE "mcp_servers"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_name_unique" ON "mcp_servers" USING btree ("project_id","name") WHERE "mcp_servers"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_scope_index" ON "mcp_servers" USING btree ("owner_id","project_id");