DROP INDEX "project_workspaces_owner_name_unique";--> statement-breakpoint
ALTER TABLE "project_workspaces" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "name_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "name_blind_index" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "name_format_version" integer;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "name_key_revision" integer;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_owner_name_blind_unique" ON "project_workspaces" USING btree ("owner_id","name_blind_index") WHERE "project_workspaces"."name_blind_index" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_name_protection_check" CHECK (("project_workspaces"."name" IS NOT NULL AND "project_workspaces"."name_envelope" IS NULL AND "project_workspaces"."name_blind_index" IS NULL AND "project_workspaces"."name_format_version" IS NULL AND "project_workspaces"."name_key_revision" IS NULL) OR ("project_workspaces"."name" IS NULL AND "project_workspaces"."name_envelope" IS NOT NULL AND "project_workspaces"."name_blind_index" IS NOT NULL AND "project_workspaces"."name_format_version" = 1 AND "project_workspaces"."name_key_revision" >= 1));--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_revision_check" CHECK ("project_workspaces"."revision" >= 1);