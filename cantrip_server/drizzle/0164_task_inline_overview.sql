UPDATE "projects"
SET "tab_layout_revision" = "tab_layout_revision" + 1,
    "updated_at" = NOW()
WHERE "id" IN (
  SELECT DISTINCT "member"."project_id"
  FROM "tab_group_members" AS "member"
  INNER JOIN "chats" AS "chat" ON "chat"."id" = "member"."tab_id"
  WHERE "member"."tab_kind" = 'chat'
    AND "chat"."experience" = 'task'
);--> statement-breakpoint
DELETE FROM "tab_group_members" AS "member"
USING "chats" AS "chat"
WHERE "member"."tab_kind" = 'chat'
  AND "member"."tab_id" = "chat"."id"
  AND "chat"."experience" = 'task';--> statement-breakpoint
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
  ) <= 1;
