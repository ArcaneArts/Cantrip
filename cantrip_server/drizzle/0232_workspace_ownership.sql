CREATE TABLE workspace_layouts (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  layout jsonb NOT NULL,
  PRIMARY KEY (owner_id, project_id, workspace_id)
);
--> statement-breakpoint
CREATE TABLE workspace_command_receipts (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  command jsonb NOT NULL,
  applied_revision bigint NOT NULL,
  PRIMARY KEY (owner_id, project_id, workspace_id, operation_id),
  FOREIGN KEY (owner_id, project_id, workspace_id)
    REFERENCES workspace_layouts(owner_id, project_id, workspace_id) ON DELETE CASCADE
);
