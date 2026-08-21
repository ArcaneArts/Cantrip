-- Pre-release destructive cutover: old run payloads were server-readable and
-- cannot be converted without an unlocked endpoint. Definitions remain intact.
TRUNCATE TABLE "workflow_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD COLUMN "protected_input" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD COLUMN "protected_result" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD COLUMN "protected_error" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD COLUMN "protected_input" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD COLUMN "protected_result" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD COLUMN "protected_error" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD COLUMN "protected_input" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD COLUMN "protected_result" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD COLUMN "protected_error" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "protected_input" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "protected_result" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "protected_error" jsonb;
