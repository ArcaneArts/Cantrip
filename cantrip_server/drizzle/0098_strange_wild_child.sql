ALTER TABLE "project_worktrees" DROP CONSTRAINT "project_worktrees_folder_root_shape_check";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_managed_folder_identity_check";--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "managed_folder_capabilities" SET DEFAULT '{"create":false,"attachExisting":false,"convertToGithub":false,"remove":false}'::jsonb;--> statement-breakpoint
UPDATE "workers"
SET "managed_folder_capabilities" = "managed_folder_capabilities" || '{"attachExisting":false}'::jsonb
WHERE NOT ("managed_folder_capabilities" ? 'attachExisting');--> statement-breakpoint
ALTER TABLE "project_folder_setup_jobs" ADD COLUMN "requested_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "folder_management" text;--> statement-breakpoint
UPDATE "projects"
SET "folder_management" = 'managed'
WHERE "origin_kind" = 'managed-folder';--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD CONSTRAINT "project_worktrees_folder_root_shape_check" CHECK ("project_worktrees"."root_kind" <> 'folder-root' OR ("project_worktrees"."is_primary" = true AND "project_worktrees"."is_default" = true AND "project_worktrees"."origin" IN ('cantrip', 'external') AND "project_worktrees"."branch" IS NULL AND "project_worktrees"."head" IS NULL AND "project_worktrees"."detached" = false));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_managed_folder_identity_check" CHECK (("projects"."origin_kind" = 'managed-folder' AND "projects"."folder_management" IN ('managed', 'external') AND "projects"."github_repository_id" IS NULL AND "projects"."github_repository_full_name" IS NULL AND "projects"."github_repository_url" IS NULL AND "projects"."worktree_policy" = 'direct') OR ("projects"."origin_kind" <> 'managed-folder' AND "projects"."folder_management" IS NULL));
