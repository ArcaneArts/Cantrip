WITH ranked_chats AS (
	SELECT "id", ROW_NUMBER() OVER (PARTITION BY "project_id" ORDER BY "position", "created_at", "id") - 1 AS "new_position"
	FROM "chats"
)
UPDATE "chats"
SET "position" = ranked_chats."new_position"
FROM ranked_chats
WHERE "chats"."id" = ranked_chats."id";
--> statement-breakpoint
WITH ranked_terminals AS (
	SELECT
		"id",
		(SELECT COUNT(*) FROM "chats" WHERE "chats"."project_id" = "terminals"."project_id")
			+ ROW_NUMBER() OVER (PARTITION BY "project_id" ORDER BY "position", "created_at", "id") - 1 AS "new_position"
	FROM "terminals"
)
UPDATE "terminals"
SET "position" = ranked_terminals."new_position"
FROM ranked_terminals
WHERE "terminals"."id" = ranked_terminals."id";
