ALTER TABLE council_agents ADD COLUMN native_history_epoch uuid;
--> statement-breakpoint
ALTER TABLE council_agents ALTER COLUMN native_history_epoch SET DEFAULT gen_random_uuid();
