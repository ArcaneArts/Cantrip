ALTER TABLE "mcp_servers" ADD COLUMN "audience" text DEFAULT 'ide' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_audience_check" CHECK ("mcp_servers"."audience" IN ('ide', 'chat', 'both'));--> statement-breakpoint

ALTER TABLE "policies" ADD COLUMN "audience" text DEFAULT 'ide' NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_audience_check" CHECK ("policies"."audience" IN ('ide', 'chat', 'both'));--> statement-breakpoint

CREATE TABLE "skill_audiences" (
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"audience_key" text NOT NULL,
	"audience" text DEFAULT 'ide' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_audiences_owner_id_worker_id_provider_id_audience_key_pk" PRIMARY KEY("owner_id","worker_id","provider_id","audience_key"),
	CONSTRAINT "skill_audiences_key_length_check" CHECK (length("skill_audiences"."audience_key") = 43),
	CONSTRAINT "skill_audiences_audience_check" CHECK ("skill_audiences"."audience" IN ('ide', 'chat', 'both'))
);--> statement-breakpoint
ALTER TABLE "skill_audiences" ADD CONSTRAINT "skill_audiences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_audiences" ADD CONSTRAINT "skill_audiences_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_audiences" ADD CONSTRAINT "skill_audiences_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_audiences_chat_lookup_index" ON "skill_audiences" USING btree ("owner_id","worker_id","provider_id","audience");
