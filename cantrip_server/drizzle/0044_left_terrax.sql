CREATE TABLE "project_automations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_automations_revision_check" CHECK ("project_automations"."revision" > 0),
	CONSTRAINT "project_automations_status_check" CHECK ("project_automations"."last_status" IN ('idle', 'dispatching', 'started', 'queued', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "project_automations" ADD CONSTRAINT "project_automations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_automations" ADD CONSTRAINT "project_automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_automations" ADD CONSTRAINT "project_automations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_automations_project_index" ON "project_automations" USING btree ("owner_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_automations_chat_index" ON "project_automations" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "project_automations_due_index" ON "project_automations" USING btree ("enabled","next_run_at");