UPDATE "projects"
SET "tab_layout_revision" = "tab_layout_revision" + 1,
    "updated_at" = NOW()
WHERE "id" IN (
  SELECT DISTINCT "project_id"
  FROM "tab_group_members"
  WHERE "tab_kind" = 'remote-desktop'
);--> statement-breakpoint
DELETE FROM "tab_group_members" WHERE "tab_kind" = 'remote-desktop';--> statement-breakpoint
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
DELETE FROM "remote_surfaces" WHERE "kind" = 'desktop';--> statement-breakpoint
DELETE FROM "project_views" WHERE "kind" = 'remote-desktop';--> statement-breakpoint
ALTER TABLE "remote_surfaces" ADD CONSTRAINT "remote_surfaces_desktop_private_state_check" CHECK ("remote_surfaces"."kind" <> 'desktop' OR ("remote_surfaces"."protected_state" IS NOT NULL AND "remote_surfaces"."state_revision" IS NOT NULL AND "remote_surfaces"."configuration" = '{"kind":"desktop"}'::jsonb));
