ALTER TABLE chats ADD COLUMN last_used_at timestamp(3) with time zone;
--> statement-breakpoint
UPDATE chats SET last_used_at = COALESCE(updated_at, created_at);
--> statement-breakpoint
ALTER TABLE chats ALTER COLUMN last_used_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE chats ALTER COLUMN last_used_at SET NOT NULL;
--> statement-breakpoint
CREATE INDEX chats_conversation_recent_index ON chats(project_id, last_used_at, created_at, id)
  WHERE context_kind = 'project' AND experience = 'agent' AND archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX chats_conversation_archive_index ON chats(project_id, archived_at, id)
  WHERE context_kind = 'project' AND experience = 'agent' AND archived_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE conversation_usage_clients (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  PRIMARY KEY (owner_id, client_id)
);
--> statement-breakpoint
CREATE TABLE conversation_usage_receipts (
  owner_id text NOT NULL,
  client_id text NOT NULL,
  operation_id text NOT NULL,
  chat_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  last_used_at timestamp(3) with time zone NOT NULL,
  applied boolean NOT NULL,
  PRIMARY KEY (owner_id, client_id, operation_id),
  FOREIGN KEY (owner_id, client_id) REFERENCES conversation_usage_clients(owner_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, owner_id) REFERENCES chats(id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE conversation_creation_requests (
  chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  request jsonb NOT NULL
);
