CREATE TABLE "project_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"automation_revision" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"dispatch_instance_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"fencing_token" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"error_message" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_automation_runs_status_check" CHECK ("project_automation_runs"."status" IN ('dispatching', 'started', 'queued', 'skipped', 'failed')),
	CONSTRAINT "project_automation_runs_fencing_token_check" CHECK ("project_automation_runs"."fencing_token" > 0),
	CONSTRAINT "project_automation_runs_attempt_count_check" CHECK ("project_automation_runs"."attempt_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "dispatch_instance_id" text;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "fencing_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_automation_runs" ADD CONSTRAINT "project_automation_runs_automation_id_project_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."project_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_automation_runs" ADD CONSTRAINT "project_automation_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_automation_runs" ADD CONSTRAINT "project_automation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_automation_runs_occurrence_unique" ON "project_automation_runs" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "project_automation_runs_recovery_index" ON "project_automation_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "project_automation_runs_owner_index" ON "project_automation_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD CONSTRAINT "workflow_trigger_deliveries_fencing_token_check" CHECK ("workflow_trigger_deliveries"."fencing_token" >= 0);