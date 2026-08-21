-- Pre-release destructive cutover: existing workflow rows cannot be encrypted
-- without their owner's unlocked key, so reset the workflow aggregate and its
-- dependent runtime rows before making protected columns required.
TRUNCATE TABLE "workflow_definitions" CASCADE;--> statement-breakpoint
DROP INDEX "workflow_definitions_personal_slug_unique";--> statement-breakpoint
DROP INDEX "workflow_definitions_project_slug_unique";--> statement-breakpoint
DROP INDEX "workflow_revisions_workflow_hash_unique";--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "slug_blind_index" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "protected_slug" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "protected_name" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "protected_description" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "protected_provenance" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD COLUMN "protected_provenance" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD COLUMN "content_blind_index" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD COLUMN "protected_content_hash" jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_personal_slug_unique" ON "workflow_definitions" USING btree ("owner_id","slug_blind_index") WHERE "workflow_definitions"."scope" = 'personal' AND "workflow_definitions"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_project_slug_unique" ON "workflow_definitions" USING btree ("project_id","slug_blind_index") WHERE "workflow_definitions"."scope" = 'project' AND "workflow_definitions"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_workflow_hash_unique" ON "workflow_revisions" USING btree ("workflow_id","content_blind_index");--> statement-breakpoint
ALTER TABLE "workflow_definitions" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "workflow_definitions" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "workflow_definitions" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "workflow_definitions" DROP COLUMN "provenance";--> statement-breakpoint
ALTER TABLE "workflow_revisions" DROP COLUMN "definition";--> statement-breakpoint
ALTER TABLE "workflow_revisions" DROP COLUMN "provenance";--> statement-breakpoint
ALTER TABLE "workflow_revisions" DROP COLUMN "content_hash";
