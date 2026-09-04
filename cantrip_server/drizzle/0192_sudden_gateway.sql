CREATE TABLE "project_builtin_surface_states" (
	"project_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"worktree_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_builtin_surface_states_project_id_definition_id_pk" PRIMARY KEY("project_id","definition_id"),
	CONSTRAINT "project_builtin_surface_states_definition_check" CHECK ("project_builtin_surface_states"."definition_id" IN ('project.overview', 'project.tasks', 'git.history', 'git.graph', 'github.issues', 'github.pull-requests', 'github.actions'))
);
--> statement-breakpoint
CREATE TABLE "project_surface_launcher_preferences" (
	"project_id" text NOT NULL,
	"location" text NOT NULL,
	"definition_id" text NOT NULL,
	"pinned" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_surface_launcher_preferences_project_id_location_definition_id_pk" PRIMARY KEY("project_id","location","definition_id"),
	CONSTRAINT "project_surface_launcher_preferences_definition_check" CHECK ("project_surface_launcher_preferences"."definition_id" IN ('project.overview', 'project.tasks', 'git.history', 'git.graph', 'github.issues', 'github.pull-requests', 'github.actions')),
	CONSTRAINT "project_surface_launcher_preferences_location_check" CHECK ("project_surface_launcher_preferences"."location" IN ('project-navigator', 'surface-catalog', 'command-palette', 'right-rail', 'bottom-rail'))
);
--> statement-breakpoint
ALTER TABLE "tab_group_members" DROP CONSTRAINT "tab_group_members_kind_check";--> statement-breakpoint
DROP INDEX "tab_group_members_surface_unique";--> statement-breakpoint
WITH "ranked_legacy_views" AS (
	SELECT
		"view"."project_id",
		CASE "view"."kind"
			WHEN 'history' THEN 'git.history'
			WHEN 'issues' THEN 'github.issues'
		END AS "definition_id",
		"view"."worktree_id",
		"view"."created_at",
		"view"."updated_at",
		ROW_NUMBER() OVER (
			PARTITION BY "view"."project_id", "view"."kind"
			ORDER BY
				CASE WHEN "member"."tab_key" IS NULL THEN 1 ELSE 0 END,
				"group"."position" NULLS LAST,
				"member"."position" NULLS LAST,
				"view"."position",
				"view"."created_at",
				"view"."id"
		) AS "rank"
	FROM "project_views" AS "view"
	LEFT JOIN "tab_group_members" AS "member"
		ON "member"."tab_kind" = "view"."kind"
		AND "member"."tab_id" = "view"."id"
		AND "member"."project_id" = "view"."project_id"
	LEFT JOIN "tab_groups" AS "group"
		ON "group"."id" = "member"."group_id"
		AND "group"."project_id" = "member"."project_id"
	WHERE "view"."kind" IN ('history', 'issues')
)
INSERT INTO "project_builtin_surface_states" (
	"project_id",
	"definition_id",
	"worktree_id",
	"created_at",
	"updated_at"
)
SELECT
	"project_id",
	"definition_id",
	"worktree_id",
	"created_at",
	"updated_at"
FROM "ranked_legacy_views"
WHERE "rank" = 1
ON CONFLICT ("project_id", "definition_id") DO NOTHING;--> statement-breakpoint
CREATE TABLE "_builtin_surface_member_migration" AS
SELECT
	"member"."tab_key" AS "old_tab_key",
	'builtin:' || "member"."project_id" || ':' ||
		CASE "member"."tab_kind"
			WHEN 'history' THEN 'git.history'
			WHEN 'issues' THEN 'github.issues'
		END AS "new_tab_key",
	"member"."project_id",
	"member"."group_id",
	CASE "member"."tab_kind"
		WHEN 'history' THEN 'git.history'
		WHEN 'issues' THEN 'github.issues'
	END AS "definition_id",
	ROW_NUMBER() OVER (
		PARTITION BY "member"."project_id", "member"."tab_kind"
		ORDER BY
			"group"."position",
			"member"."position",
			"member"."created_at",
			"member"."tab_key"
	) AS "rank"
FROM "tab_group_members" AS "member"
INNER JOIN "tab_groups" AS "group"
	ON "group"."id" = "member"."group_id"
	AND "group"."project_id" = "member"."project_id"
WHERE "member"."tab_kind" IN ('history', 'issues');--> statement-breakpoint
UPDATE "projects" AS "project"
SET "tab_layout_revision" = "project"."tab_layout_revision" + 1,
	"updated_at" = NOW()
WHERE EXISTS (
	SELECT 1
	FROM "_builtin_surface_member_migration" AS "migration"
	WHERE "migration"."project_id" = "project"."id"
);--> statement-breakpoint
DELETE FROM "tab_group_members" AS "member"
USING "_builtin_surface_member_migration" AS "migration"
WHERE "migration"."rank" > 1
	AND "member"."tab_key" = "migration"."old_tab_key";--> statement-breakpoint
UPDATE "tab_groups" AS "group"
SET "anchor_tab_key" = "migration"."new_tab_key",
	"updated_at" = NOW()
FROM "_builtin_surface_member_migration" AS "migration"
WHERE "migration"."rank" = 1
	AND "group"."project_id" = "migration"."project_id"
	AND "group"."id" = "migration"."group_id"
	AND "group"."anchor_tab_key" = "migration"."old_tab_key";--> statement-breakpoint
UPDATE "tab_group_members" AS "member"
SET "tab_key" = "migration"."new_tab_key",
	"tab_kind" = 'builtin',
	"tab_id" = "migration"."definition_id",
	"updated_at" = NOW()
FROM "_builtin_surface_member_migration" AS "migration"
WHERE "migration"."rank" = 1
	AND "member"."tab_key" = "migration"."old_tab_key";--> statement-breakpoint
DELETE FROM "project_views"
WHERE "kind" IN ('history', 'issues');--> statement-breakpoint
DELETE FROM "tab_groups" AS "group"
WHERE NOT EXISTS (
	SELECT 1
	FROM "tab_group_members" AS "member"
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
	SELECT 1
	FROM "tab_group_members" AS "member"
	WHERE "member"."group_id" = "group"."id"
		AND "member"."project_id" = "group"."project_id"
		AND "member"."tab_key" = "group"."anchor_tab_key"
);--> statement-breakpoint
UPDATE "tab_groups" AS "group"
SET "protected_label" = NULL,
	"updated_at" = NOW()
WHERE "protected_label" IS NOT NULL
	AND (
		SELECT COUNT(*)
		FROM "tab_group_members" AS "member"
		WHERE "member"."group_id" = "group"."id"
			AND "member"."project_id" = "group"."project_id"
	) <= 1;--> statement-breakpoint
WITH "ranked_members" AS (
	SELECT
		"tab_key",
		ROW_NUMBER() OVER (
			PARTITION BY "group_id"
			ORDER BY "position", "created_at", "tab_key"
		) - 1 AS "next_position"
	FROM "tab_group_members"
)
UPDATE "tab_group_members" AS "member"
SET "position" = "ranked"."next_position"
FROM "ranked_members" AS "ranked"
WHERE "member"."tab_key" = "ranked"."tab_key"
	AND "member"."position" <> "ranked"."next_position";--> statement-breakpoint
WITH "ranked_groups" AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "project_id"
			ORDER BY "position", "created_at", "id"
		) - 1 AS "next_position"
	FROM "tab_groups"
)
UPDATE "tab_groups" AS "group"
SET "position" = "ranked"."next_position"
FROM "ranked_groups" AS "ranked"
WHERE "group"."id" = "ranked"."id"
	AND "group"."position" <> "ranked"."next_position";--> statement-breakpoint
DROP TABLE "_builtin_surface_member_migration";--> statement-breakpoint
ALTER TABLE "project_builtin_surface_states" ADD CONSTRAINT "project_builtin_surface_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_builtin_surface_states" ADD CONSTRAINT "project_builtin_surface_states_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_surface_launcher_preferences" ADD CONSTRAINT "project_surface_launcher_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tab_group_members_surface_unique" ON "tab_group_members" USING btree ("project_id","tab_kind","tab_id");--> statement-breakpoint
ALTER TABLE "project_views" ADD CONSTRAINT "project_views_kind_check" CHECK ("project_views"."kind" = 'remote-desktop');--> statement-breakpoint
ALTER TABLE "tab_group_members" ADD CONSTRAINT "tab_group_members_kind_check" CHECK ("tab_group_members"."tab_kind" IN ('chat', 'terminal', 'explorer', 'browser', 'code', 'history', 'issues', 'remote-desktop', 'builtin'));
