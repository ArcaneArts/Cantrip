CREATE TABLE "project_workspace_memberships" (
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workspace_memberships_workspace_id_project_id_pk" PRIMARY KEY("workspace_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_workspace_memberships" ADD CONSTRAINT "project_workspace_memberships_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspace_memberships" ADD CONSTRAINT "project_workspace_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_workspace_memberships_project_index" ON "project_workspace_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_owner_name_unique" ON "project_workspaces" USING btree ("owner_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_owner_default_unique" ON "project_workspaces" USING btree ("owner_id") WHERE "project_workspaces"."is_default" = true;--> statement-breakpoint
CREATE INDEX "project_workspaces_owner_position_index" ON "project_workspaces" USING btree ("owner_id","position");--> statement-breakpoint
INSERT INTO "project_workspaces" ("id", "owner_id", "name", "position", "is_default")
SELECT 'workspace:default:' || "id", "id", 'Default', 0, true
FROM "users";--> statement-breakpoint
INSERT INTO "project_workspace_memberships" ("workspace_id", "project_id")
SELECT 'workspace:default:' || "owner_id", "id"
FROM "projects";
