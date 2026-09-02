INSERT INTO "project_workspace_memberships" ("workspace_id", "project_id")
SELECT "project_workspaces"."id", "projects"."id"
FROM "projects"
INNER JOIN "project_workspaces"
  ON "project_workspaces"."owner_id" = "projects"."owner_id"
  AND "project_workspaces"."is_default" = true
WHERE NOT EXISTS (
  SELECT 1
  FROM "project_workspace_memberships"
  WHERE "project_workspace_memberships"."project_id" = "projects"."id"
);
--> statement-breakpoint
WITH "ranked_memberships" AS (
  SELECT
    "project_workspace_memberships"."workspace_id",
    "project_workspace_memberships"."project_id",
    row_number() OVER (
      PARTITION BY "project_workspace_memberships"."project_id"
      ORDER BY
        "project_workspaces"."is_default" ASC,
        "project_workspace_memberships"."created_at" ASC,
        "project_workspaces"."position" ASC,
        "project_workspace_memberships"."workspace_id" ASC
    ) AS "assignment_rank"
  FROM "project_workspace_memberships"
  INNER JOIN "project_workspaces"
    ON "project_workspaces"."id" = "project_workspace_memberships"."workspace_id"
)
DELETE FROM "project_workspace_memberships"
WHERE ("workspace_id", "project_id") IN (
  SELECT "workspace_id", "project_id"
  FROM "ranked_memberships"
  WHERE "assignment_rank" > 1
);
--> statement-breakpoint
DROP INDEX "project_workspace_memberships_project_index";
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspace_memberships_project_unique"
ON "project_workspace_memberships" USING btree ("project_id");
--> statement-breakpoint
ALTER TABLE "project_workspace_memberships"
DROP CONSTRAINT "project_workspace_memberships_workspace_id_project_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "project_workspace_memberships"
ADD CONSTRAINT "project_workspace_memberships_workspace_id_project_workspaces_id_fk"
FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id")
ON DELETE restrict ON UPDATE no action;
