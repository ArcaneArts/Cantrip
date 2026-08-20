ALTER TABLE "agent_interaction_requests" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD COLUMN "protected_payload" jsonb;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD COLUMN "protected_response" jsonb;