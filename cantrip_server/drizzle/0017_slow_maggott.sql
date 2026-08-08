CREATE TABLE "remote_surfaces" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"preferred_transport" text DEFAULT 'websocket' NOT NULL,
	"configuration" jsonb NOT NULL,
	"last_error" text,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "remote_surface_capabilities" jsonb DEFAULT '{"browser":false,"desktop":false,"transports":["websocket"],"maxSessions":4}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_surfaces" ADD CONSTRAINT "remote_surfaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_surfaces" ADD CONSTRAINT "remote_surfaces_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
