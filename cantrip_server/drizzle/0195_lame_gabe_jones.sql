ALTER TABLE "projects" ADD COLUMN "center_layout_root" jsonb;
--> statement-breakpoint
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
    INNER JOIN "tab_groups" AS "pane"
      ON "pane"."project_id" = "project"."id"
      AND "pane"."region" = 'center'
    WHERE "project"."center_layout_root" IS NULL
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
    WHERE "id" = "center_project"."project_id"
      AND "center_layout_root" IS NULL;
  END LOOP;
END $$;
