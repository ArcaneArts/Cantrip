-- Trigger content cannot be upgraded without an endpoint-held workflow-content
-- key. This pre-release cutover intentionally requires the documented server
-- wipe before deployment and never copies legacy plaintext into new columns.
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "public_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "credential_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "protected_name" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "protected_configuration" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "protected_input" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "public_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" ADD COLUMN "protected_payload" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" DROP COLUMN "configuration";--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" DROP COLUMN "structured_input";--> statement-breakpoint
ALTER TABLE "workflow_automation_triggers" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" DROP COLUMN "trigger_provenance";--> statement-breakpoint
ALTER TABLE "workflow_trigger_deliveries" DROP COLUMN "error_message";
