ALTER TABLE "tab_groups" ADD COLUMN "title" text;
--> statement-breakpoint
UPDATE "tab_groups" AS "tg"
SET "title" = COALESCE(
	(SELECT "title" FROM "chats" WHERE 'chat:' || "id" = "tg"."anchor_tab_key"),
	(SELECT "title" FROM "terminals" WHERE 'terminal:' || "id" = "tg"."anchor_tab_key"),
	(SELECT "title" FROM "explorers" WHERE 'explorer:' || "id" = "tg"."anchor_tab_key"),
	(SELECT "title" FROM "browsers" WHERE 'browser:' || "id" = "tg"."anchor_tab_key"),
	(SELECT "title" FROM "code_tabs" WHERE 'code:' || "id" = "tg"."anchor_tab_key"),
	(SELECT "title" FROM "project_views" WHERE 'view:' || "id" = "tg"."anchor_tab_key")
)
WHERE (
	SELECT count(*)
	FROM "tab_group_members"
	WHERE "group_id" = "tg"."id"
) > 1;
