ALTER TABLE council_agents
  ADD COLUMN protected_memory jsonb,
  ADD COLUMN memory_revision integer NOT NULL DEFAULT 1;
