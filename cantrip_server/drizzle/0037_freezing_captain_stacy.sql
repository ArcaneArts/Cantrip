CREATE TABLE "tab_group_members" (
	"tab_key" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tab_kind" text NOT NULL,
	"tab_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tab_group_members_kind_check" CHECK ("tab_group_members"."tab_kind" IN ('chat', 'terminal', 'explorer', 'browser', 'code', 'history', 'issues', 'remote-desktop'))
);
--> statement-breakpoint
CREATE TABLE "tab_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"anchor_tab_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tab_layout_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tab_groups_id_project_unique" ON "tab_groups" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "tab_group_members" ADD CONSTRAINT "tab_group_members_group_project_fk" FOREIGN KEY ("group_id","project_id") REFERENCES "public"."tab_groups"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tab_groups" ADD CONSTRAINT "tab_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tab_group_members_surface_unique" ON "tab_group_members" USING btree ("tab_kind","tab_id");--> statement-breakpoint
CREATE INDEX "tab_group_members_group_position_index" ON "tab_group_members" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "tab_groups_project_position_index" ON "tab_groups" USING btree ("project_id","position");--> statement-breakpoint
WITH visible_tabs AS (
	SELECT "project_id", 'chat:' || "id" AS tab_key, 'chat' AS tab_kind, "id" AS tab_id, "position", "created_at", "updated_at" FROM "chats"
	UNION ALL
	SELECT "project_id", 'terminal:' || "id", 'terminal', "id", "position", "created_at", "updated_at" FROM "terminals" WHERE "linked_chat_id" IS NULL
	UNION ALL
	SELECT "project_id", 'explorer:' || "id", 'explorer', "id", "position", "created_at", "updated_at" FROM "explorers"
	UNION ALL
	SELECT "project_id", 'browser:' || "id", 'browser', "id", "position", "created_at", "updated_at" FROM "browsers"
	UNION ALL
	SELECT "project_id", 'code:' || "id", 'code', "id", "position", "created_at", "updated_at" FROM "code_tabs"
	UNION ALL
	SELECT "project_id", 'view:' || "id", "kind", "id", "position", "created_at", "updated_at" FROM "project_views"
), ordered_tabs AS (
	SELECT *, row_number() OVER (PARTITION BY "project_id" ORDER BY "position", tab_key) - 1 AS group_position
	FROM visible_tabs
)
INSERT INTO "tab_groups" ("id", "project_id", "position", "anchor_tab_key", "created_at", "updated_at")
SELECT 'singleton:' || tab_key, "project_id", group_position, tab_key, "created_at", "updated_at"
FROM ordered_tabs;--> statement-breakpoint
WITH visible_tabs AS (
	SELECT "project_id", 'chat:' || "id" AS tab_key, 'chat' AS tab_kind, "id" AS tab_id, "created_at", "updated_at" FROM "chats"
	UNION ALL
	SELECT "project_id", 'terminal:' || "id", 'terminal', "id", "created_at", "updated_at" FROM "terminals" WHERE "linked_chat_id" IS NULL
	UNION ALL
	SELECT "project_id", 'explorer:' || "id", 'explorer', "id", "created_at", "updated_at" FROM "explorers"
	UNION ALL
	SELECT "project_id", 'browser:' || "id", 'browser', "id", "created_at", "updated_at" FROM "browsers"
	UNION ALL
	SELECT "project_id", 'code:' || "id", 'code', "id", "created_at", "updated_at" FROM "code_tabs"
	UNION ALL
	SELECT "project_id", 'view:' || "id", "kind", "id", "created_at", "updated_at" FROM "project_views"
)
INSERT INTO "tab_group_members" ("tab_key", "group_id", "project_id", "tab_kind", "tab_id", "position", "created_at", "updated_at")
SELECT tab_key, 'singleton:' || tab_key, "project_id", tab_kind, tab_id, 0, "created_at", "updated_at"
FROM visible_tabs;--> statement-breakpoint
UPDATE "projects"
SET "tab_layout_revision" = 1
WHERE EXISTS (SELECT 1 FROM "tab_groups" WHERE "tab_groups"."project_id" = "projects"."id");
