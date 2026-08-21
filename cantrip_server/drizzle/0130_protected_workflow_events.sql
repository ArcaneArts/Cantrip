-- Workflow event payloads and run control reasons cannot be upgraded without
-- an endpoint-held workflow-content key. The pre-release cutover deliberately
-- drops those legacy plaintext columns; existing accounts are wiped before
-- launch and every new write uses either curated public metadata or ciphertext.
ALTER TABLE "workflow_run_events" ADD COLUMN "public_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD COLUMN "protected_payload" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "protected_pause_reason" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "protected_cancel_reason" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_events" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP COLUMN "pause_reason";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP COLUMN "cancel_reason";
