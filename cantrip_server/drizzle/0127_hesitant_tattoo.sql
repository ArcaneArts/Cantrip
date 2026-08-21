-- Pre-release destructive cutover: existing workflow definitions cannot be
-- encrypted without an unlocked owner endpoint. Reset the workflow aggregate
-- and all dependent runtime rows before requiring the opaque definition.
TRUNCATE TABLE "workflow_definitions" CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD COLUMN "protected_definition" jsonb NOT NULL;
