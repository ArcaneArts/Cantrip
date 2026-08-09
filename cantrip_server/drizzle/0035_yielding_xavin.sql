CREATE TABLE "workflow_automation_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_revision_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"structured_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_model_route_id" text,
	"selected_permission_profile_id" text,
	"next_run_at" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"last_run_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_automation_triggers_type_check" CHECK ("workflow_automation_triggers"."type" IN ('schedule', 'api', 'webhook', 'git', 'saved-command'))
);
--> statement-breakpoint
CREATE TABLE "workflow_trigger_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_trigger_deliveries_status_check" CHECK ("workflow_trigger_deliveries"."status" IN ('pending', 'accepted', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_workflow_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("workflow_revision_id") REFERENCES "public"."workflow_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_selected_model_route_id_model_routes_id_fk" FOREIGN KEY ("selected_model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD CONSTRAINT "workflow_automation_triggers_last_run_id_workflow_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD CONSTRAINT "workflow_trigger_deliveries_trigger_id_workflow_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_automation_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD CONSTRAINT "workflow_trigger_deliveries_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_automation_triggers_owner_index" ON "workflow_automation_triggers" USING btree ("owner_id","project_id","type");--> statement-breakpoint
CREATE INDEX "workflow_automation_triggers_due_index" ON "workflow_automation_triggers" USING btree ("enabled","type","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_trigger_deliveries_idempotency_unique" ON "workflow_trigger_deliveries" USING btree ("trigger_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_trigger_deliveries_trigger_created_index" ON "workflow_trigger_deliveries" USING btree ("trigger_id","created_at");