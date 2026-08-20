-- Pre-release destructive project-domain reset: removing projects cascades to
-- project-owned chats/Tasks, surfaces, tab layouts, sources/worktrees, jobs,
-- automations, policies, interactions, MCP records, Git operations, and
-- project-scoped workflow records. Nullable analytics, tunnel, and workflow-run
-- project references become NULL. Users/auth, encryption profiles, principals,
-- grants, workers/credentials, account settings, and project_workspaces remain;
-- only their project_workspace_memberships cascade.
DELETE FROM "projects";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "name";
