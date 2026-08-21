-- Pre-release cutover: scheduled automation content was previously readable by
-- the server. Existing automation/run rows are disposable and cannot be
-- safely converted without the account component key.
DELETE FROM "project_automations";--> statement-breakpoint
ALTER TABLE "project_automations" ADD COLUMN "protected_name" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automations" ADD COLUMN "protected_prompt" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automations" ADD COLUMN "protected_condition" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automations" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "project_automations" DROP COLUMN "prompt";--> statement-breakpoint
ALTER TABLE "project_automations" DROP COLUMN "condition";
