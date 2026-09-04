DROP INDEX "tab_groups_project_position_index";--> statement-breakpoint
ALTER TABLE "tab_groups" ADD COLUMN "region" text;--> statement-breakpoint
CREATE TEMP TABLE "_pane_region_migration_projects" AS
SELECT DISTINCT "project_id"
FROM "tab_groups"
WHERE "region" IS NULL;--> statement-breakpoint
UPDATE "projects" AS "project"
SET "tab_layout_revision" = "project"."tab_layout_revision" + 1,
	"updated_at" = NOW()
WHERE EXISTS (
	SELECT 1
	FROM "_pane_region_migration_projects" AS "migration"
	WHERE "migration"."project_id" = "project"."id"
);--> statement-breakpoint
UPDATE "tab_groups"
SET "region" = 'center',
	"updated_at" = NOW()
WHERE "region" IS NULL;--> statement-breakpoint
DROP TABLE "_pane_region_migration_projects";--> statement-breakpoint
ALTER TABLE "tab_groups" ALTER COLUMN "region" SET DEFAULT 'center';--> statement-breakpoint
ALTER TABLE "tab_groups" ALTER COLUMN "region" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "tab_groups_project_position_index" ON "tab_groups" USING btree ("project_id","region","position");--> statement-breakpoint
ALTER TABLE "tab_groups" ADD CONSTRAINT "tab_groups_region_check" CHECK ("tab_groups"."region" IN ('center', 'right', 'bottom', 'left', 'detached'));
