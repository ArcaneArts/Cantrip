CREATE TABLE "project_workspace_storage_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"worker_id" text,
	"protected_root_path_handle" text,
	"protected_display_handle" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workspace_storage_profiles_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "project_workspace_storage_profiles_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "project_workspace_storage_profiles_kind_check" CHECK ("project_workspace_storage_profiles"."kind" IN ('system', 'legacy', 'managed', 'attached')),
	CONSTRAINT "project_workspace_storage_profiles_binding_check" CHECK (("project_workspace_storage_profiles"."kind" = 'attached' AND "project_workspace_storage_profiles"."worker_id" IS NOT NULL AND "project_workspace_storage_profiles"."protected_root_path_handle" IS NOT NULL AND "project_workspace_storage_profiles"."protected_display_handle" IS NOT NULL) OR ("project_workspace_storage_profiles"."kind" <> 'attached' AND "project_workspace_storage_profiles"."worker_id" IS NULL AND "project_workspace_storage_profiles"."protected_root_path_handle" IS NULL AND "project_workspace_storage_profiles"."protected_display_handle" IS NULL)),
	CONSTRAINT "project_workspace_storage_profiles_root_handle_check" CHECK ("project_workspace_storage_profiles"."protected_root_path_handle" IS NULL OR "project_workspace_storage_profiles"."protected_root_path_handle" ~ '^ctrr_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "project_workspace_storage_profiles_display_handle_check" CHECK ("project_workspace_storage_profiles"."protected_display_handle" IS NULL OR "project_workspace_storage_profiles"."protected_display_handle" ~ '^ctrr_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "project_workspace_storage_profiles_revision_check" CHECK ("project_workspace_storage_profiles"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspace_storage_profiles_worker_root_unique" ON "project_workspace_storage_profiles" USING btree ("worker_id","protected_root_path_handle") WHERE "project_workspace_storage_profiles"."kind" = 'attached';
--> statement-breakpoint
CREATE INDEX "project_workspace_storage_profiles_worker_index" ON "project_workspace_storage_profiles" USING btree ("worker_id") WHERE "project_workspace_storage_profiles"."worker_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "project_workspace_storage_profiles" (
	"workspace_id",
	"kind"
)
SELECT
	"id",
	CASE
		WHEN "id" = ('workspace:default:' || "owner_id") THEN 'system'
		ELSE 'legacy'
	END
FROM "project_workspaces"
ON CONFLICT ("workspace_id") DO NOTHING;
