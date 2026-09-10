CREATE TABLE managed_chat_preparations (
  chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  terminal_id text NOT NULL,
  generation text NOT NULL,
  phase text NOT NULL DEFAULT 'pending' CONSTRAINT managed_chat_preparations_phase_check CHECK (phase IN ('pending','thread','console','ready','failed')),
  failed_phase text CONSTRAINT managed_chat_preparations_failed_phase_check CHECK (failed_phase IN ('thread','console')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX managed_chat_preparations_worker ON managed_chat_preparations(owner_id, worker_id);
