CREATE TABLE file_documents (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Historical location bindings survive checkout/worker removal. Live authority
  -- is checked transactionally on creation and again for every file operation.
  worker_id text NOT NULL,
  worktree_id text NOT NULL,
  protected_state jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX file_documents_project_index ON file_documents(project_id);
