ALTER TABLE "project_automations" DROP CONSTRAINT "project_automations_status_check";--> statement-breakpoint
ALTER TABLE "project_automations" ADD COLUMN "condition" jsonb;--> statement-breakpoint
ALTER TABLE "project_automations" ADD CONSTRAINT "project_automations_status_check" CHECK ("project_automations"."last_status" IN ('idle', 'dispatching', 'started', 'queued', 'skipped', 'failed'));