CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" text,
	"actor_user_id" text,
	"actor_session_id" text,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"request_id" text,
	"ip_address_hash" text,
	"user_agent_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_result_check" CHECK ("audit_events"."result" IN ('succeeded', 'failed', 'denied'))
);
--> statement-breakpoint
CREATE INDEX "audit_events_owner_cursor_index" ON "audit_events" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_action_cursor_index" ON "audit_events" USING btree ("action","id");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_index" ON "audit_events" USING btree ("occurred_at");