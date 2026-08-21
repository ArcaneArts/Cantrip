-- Protected gate requests cannot be manufactured by the server for existing
-- plaintext rows. Drop the old semantic columns without resetting any remote
-- database; pre-cutover gate rows remain fail-closed until the planned
-- pre-release server wipe.
ALTER TABLE "workflow_approval_gates" DROP CONSTRAINT "workflow_approval_gates_interaction_request_id_agent_interaction_requests_id_fk";
--> statement-breakpoint
DROP INDEX "workflow_approval_gates_interaction_unique";--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD COLUMN "denial_policy" text DEFAULT 'fail-run' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD COLUMN "protected_request" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD COLUMN "protected_response" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" DROP COLUMN "prompt";--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" DROP COLUMN "permission_manifest";--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" DROP COLUMN "interaction_request_id";--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" DROP COLUMN "decision_reason";--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD CONSTRAINT "workflow_approval_gates_denial_policy_check" CHECK ("workflow_approval_gates"."denial_policy" IN ('fail-run', 'skip-downstream'));
