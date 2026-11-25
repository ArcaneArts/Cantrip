ALTER TABLE "project_workspaces" ADD COLUMN "external_mcp_execution" text DEFAULT 'disabled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_external_mcp_execution_check"
  CHECK ("external_mcp_execution" IN ('disabled', 'read-only', 'workspace-write'));
