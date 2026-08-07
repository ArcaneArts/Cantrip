CREATE TABLE "terminals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"active_worker_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_active_worker_id_workers_id_fk" FOREIGN KEY ("active_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;