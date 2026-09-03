DELETE FROM "agent_interaction_requests"
WHERE "workflow_run_id" IS NOT NULL
   OR "workflow_node_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "tunnels"
WHERE "origin" = 'workflow'
   OR "managed_by_kind" = 'workflow';--> statement-breakpoint
DELETE FROM "project_branch_leases"
WHERE "workflow_worktree_lease_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "account_storage_usage_current"
WHERE "category" = 'workflows';--> statement-breakpoint
DELETE FROM "account_storage_usage_snapshots"
WHERE "category" = 'workflows';--> statement-breakpoint
ALTER TABLE "project_branch_leases" DROP CONSTRAINT "project_branch_leases_holder_check";--> statement-breakpoint
ALTER TABLE "project_branch_leases" DROP CONSTRAINT "project_branch_leases_workflow_worktree_lease_id_workflow_worktree_leases_id_fk";--> statement-breakpoint
DROP INDEX "project_branch_leases_workflow_lease_unique";--> statement-breakpoint
ALTER TABLE "project_branch_leases" DROP COLUMN "workflow_worktree_lease_id";--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_holder_check" CHECK ("project_branch_leases"."chat_execution_lane_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" DROP COLUMN "workflow_run_id";--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" DROP COLUMN "workflow_node_id";--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_origin_check";--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_origin_check" CHECK ("tunnels"."origin" IN ('user', 'browser', 'project-share', 'code', 'system'));--> statement-breakpoint
DROP TABLE "workflow_trigger_deliveries";--> statement-breakpoint
DROP TABLE "workflow_approval_gates";--> statement-breakpoint
DROP TABLE "workflow_run_events";--> statement-breakpoint
DROP TABLE "workflow_worktree_leases";--> statement-breakpoint
DROP TABLE "workflow_node_attempts";--> statement-breakpoint
DROP TABLE "workflow_run_node_dependencies";--> statement-breakpoint
DROP TABLE "workflow_run_node_items";--> statement-breakpoint
DROP TABLE "workflow_run_nodes";--> statement-breakpoint
DROP TABLE "workflow_automation_triggers";--> statement-breakpoint
DROP TABLE "workflow_runs";--> statement-breakpoint
DROP TABLE "workflow_revision_edges";--> statement-breakpoint
DROP TABLE "workflow_revision_nodes";--> statement-breakpoint
DROP TABLE "workflow_revisions";--> statement-breakpoint
DROP TABLE "workflow_definitions";
