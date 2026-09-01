ALTER TABLE "projects" ADD COLUMN "git_capability" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_capability" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "projects"
SET "git_capability" = false, "github_capability" = false
WHERE "origin_kind" = 'managed-folder';
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_managed_folder_identity_check";
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_managed_folder_identity_check" CHECK (
  (
    "origin_kind" = 'managed-folder'
    AND "folder_management" IN ('managed', 'external')
    AND "worktree_policy" = 'direct'
    AND (
      (
        "github_repository_blind_index" IS NULL
        AND "github_repository_id" IS NULL
        AND "github_repository_full_name" IS NULL
        AND "github_repository_url" IS NULL
      )
      OR
      (
        "github_repository_blind_index" IS NOT NULL
        AND "github_repository_id" IS NOT NULL
        AND "github_repository_full_name" IS NOT NULL
        AND "github_repository_url" IS NOT NULL
      )
    )
  )
  OR
  (
    "origin_kind" <> 'managed-folder'
    AND "folder_management" IS NULL
    AND "github_repository_blind_index" IS NOT NULL
  )
);
