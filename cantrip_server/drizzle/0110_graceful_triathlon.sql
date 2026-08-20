UPDATE "projects"
SET "tab_layout_revision" = "tab_layout_revision" + 1,
    "updated_at" = NOW()
WHERE "id" IN (
  SELECT DISTINCT "project_id"
  FROM "tab_group_members"
  WHERE "tab_kind" = 'explorer'
);--> statement-breakpoint
DELETE FROM "tab_group_members" WHERE "tab_kind" = 'explorer';--> statement-breakpoint
DELETE FROM "tab_groups" AS "group"
WHERE NOT EXISTS (
  SELECT 1 FROM "tab_group_members" AS "member"
  WHERE "member"."group_id" = "group"."id"
    AND "member"."project_id" = "group"."project_id"
);--> statement-breakpoint
UPDATE "tab_groups" AS "group"
SET "anchor_tab_key" = (
      SELECT "member"."tab_key"
      FROM "tab_group_members" AS "member"
      WHERE "member"."group_id" = "group"."id"
        AND "member"."project_id" = "group"."project_id"
      ORDER BY "member"."position", "member"."created_at", "member"."tab_key"
      LIMIT 1
    ),
    "updated_at" = NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "tab_group_members" AS "member"
  WHERE "member"."group_id" = "group"."id"
    AND "member"."project_id" = "group"."project_id"
    AND "member"."tab_key" = "group"."anchor_tab_key"
);--> statement-breakpoint
UPDATE "tab_groups" AS "group"
SET "protected_label" = NULL,
    "updated_at" = NOW()
WHERE "protected_label" IS NOT NULL
  AND (
    SELECT COUNT(*) FROM "tab_group_members" AS "member"
    WHERE "member"."group_id" = "group"."id"
      AND "member"."project_id" = "group"."project_id"
  ) <= 1;--> statement-breakpoint
DELETE FROM "explorers";--> statement-breakpoint
ALTER TABLE "explorers" ADD COLUMN "protected_state" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "explorers" DROP COLUMN "selected_path";
