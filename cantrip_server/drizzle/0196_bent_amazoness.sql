ALTER TABLE "user_settings" ADD COLUMN "workspace_layout_profile" text DEFAULT 'hybrid' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_workspace_layout_profile_check" CHECK ("user_settings"."workspace_layout_profile" IN ('agent', 'hybrid', 'ide'));--> statement-breakpoint
CREATE TEMP TABLE "_detached_pane_migration_projects" AS
SELECT DISTINCT "project_id"
FROM "tab_groups"
WHERE "region" = 'detached';--> statement-breakpoint
UPDATE "tab_groups"
SET "region" = 'center',
	"updated_at" = NOW()
WHERE "region" = 'detached';--> statement-breakpoint
WITH "ranked_center_panes" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "project_id"
			ORDER BY "position", "id"
		) - 1 AS "normalized_position"
	FROM "tab_groups"
	WHERE "region" = 'center'
		AND "project_id" IN (
			SELECT "project_id" FROM "_detached_pane_migration_projects"
		)
)
UPDATE "tab_groups" AS "pane"
SET "position" = "ranked"."normalized_position",
	"updated_at" = NOW()
FROM "ranked_center_panes" AS "ranked"
WHERE "pane"."id" = "ranked"."id";--> statement-breakpoint
UPDATE "projects" AS "project"
SET "center_layout_root" = NULL,
	"tab_layout_revision" = "project"."tab_layout_revision" + 1,
	"updated_at" = NOW()
WHERE "project"."id" IN (
	SELECT "project_id" FROM "_detached_pane_migration_projects"
);--> statement-breakpoint
DO $$
DECLARE
  "center_project" RECORD;
  "center_pane_id" text;
  "center_nodes" jsonb[];
  "next_nodes" jsonb[];
  "center_index" integer;
  "split_number" integer;
BEGIN
  FOR "center_project" IN
    SELECT
      "project"."id" AS "project_id",
      array_agg("pane"."id" ORDER BY "pane"."position", "pane"."id") AS "pane_ids"
    FROM "projects" AS "project"
    INNER JOIN "_detached_pane_migration_projects" AS "migration"
      ON "migration"."project_id" = "project"."id"
    INNER JOIN "tab_groups" AS "pane"
      ON "pane"."project_id" = "project"."id"
      AND "pane"."region" = 'center'
    GROUP BY "project"."id"
  LOOP
    "center_nodes" := ARRAY[]::jsonb[];
    FOREACH "center_pane_id" IN ARRAY "center_project"."pane_ids"
    LOOP
      "center_nodes" := array_append(
        "center_nodes",
        jsonb_build_object('kind', 'pane', 'paneId', "center_pane_id")
      );
    END LOOP;

    "split_number" := 0;
    WHILE array_length("center_nodes", 1) > 1
    LOOP
      "next_nodes" := ARRAY[]::jsonb[];
      "center_index" := 1;
      WHILE "center_index" <= array_length("center_nodes", 1)
      LOOP
        IF "center_index" = array_length("center_nodes", 1) THEN
          "next_nodes" := array_append(
            "next_nodes",
            "center_nodes"["center_index"]
          );
        ELSE
          "split_number" := "split_number" + 1;
          "next_nodes" := array_append(
            "next_nodes",
            jsonb_build_object(
              'kind', 'split',
              'id', 'migration:center:' || "center_project"."project_id" || ':' || "split_number",
              'direction', 'horizontal',
              'fraction', 0.5,
              'first', "center_nodes"["center_index"],
              'second', "center_nodes"["center_index" + 1]
            )
          );
        END IF;
        "center_index" := "center_index" + 2;
      END LOOP;
      "center_nodes" := "next_nodes";
    END LOOP;

    UPDATE "projects"
    SET "center_layout_root" = "center_nodes"[1]
    WHERE "id" = "center_project"."project_id";
  END LOOP;
END $$;--> statement-breakpoint
DROP TABLE "_detached_pane_migration_projects";--> statement-breakpoint
ALTER TABLE "tab_groups" DROP CONSTRAINT "tab_groups_region_check";--> statement-breakpoint
ALTER TABLE "tab_groups" ADD CONSTRAINT "tab_groups_region_check" CHECK ("tab_groups"."region" IN ('center', 'right', 'bottom', 'left'));
